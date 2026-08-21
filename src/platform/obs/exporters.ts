// Exporters (spec 0011, lane W4-K).
//
// Two exporters and a no-op, chosen from env by index.ts:
//
//  * JsonStdoutExporter — the default. One JSON line per span, trace_id
//    first, to stdout, which is what Vercel's log collector and `docker
//    logs` both consume. The line carries `correlation_id` and `trace_id`
//    (identical values) so a log line and a span line join by either field.
//  * OtlpJsonHttpExporter — optional and off by default; enabled only when
//    OTEL_EXPORTER_OTLP_ENDPOINT is set. Sends the OTLP/HTTP JSON wire
//    format (ExportTraceServiceRequest) to <endpoint>/v1/traces. The wire
//    format is hand-written here — protojson of the OTLP proto — because
//    the no-new-dependency constraint extends to the protobuf runtime.
//    Preferred replacement once dependencies are allowed:
//    `@opentelemetry/api` + `@opentelemetry/exporter-trace-otlp-http`.
//  * NoopExporter — enabled by OTEL_SDK_DISABLED=1.

import { createHash } from "node:crypto";
import type { Span, SpanAttributes, SpanExporter, SpanKind, SpanResource } from "./types";

/** The canonical JSON line the stdout exporter emits (one line per span). */
export function spanToJson(span: Span, resource: SpanResource): Record<string, unknown> {
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    start_time: new Date(span.startTime).toISOString(),
    end_time: span.endTime === null ? null : new Date(span.endTime).toISOString(),
    duration_ms: span.durationMs === null ? null : Math.round(span.durationMs * 1000) / 1000,
    status: span.status,
    error: span.error,
    attributes: span.attributes,
    resource,
  };
}

export class JsonStdoutExporter implements SpanExporter {
  constructor(private readonly resource: SpanResource) {}

  export(span: Span): void {
    // correlation_id first, then the canonical span fields (trace_id is the
    // same value) — a span line and a log line join on either key.
    console.log(
      JSON.stringify({ correlation_id: span.traceId, ...spanToJson(span, this.resource) }),
    );
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

export class NoopExporter implements SpanExporter {
  export(_span: Span): void {
    void _span; // no-op exporter: the span is deliberately discarded
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// OTLP/HTTP JSON export.
// ---------------------------------------------------------------------------

const OTLP_KIND: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

/**
 * Maps a correlation_id to the 16 bytes OTLP requires for a trace id.
 * A canonical UUID decodes losslessly (so a collector can show the id
 * the logs carry); anything else (custom header values) is hashed to a
 * stable 16 bytes.
 */
export function otlpTraceIdBytes(correlationId: string): Buffer {
  const hex = correlationId.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, "hex");
  return createHash("sha256").update(correlationId, "utf8").digest().subarray(0, 16);
}

function otlpAttributes(attributes: SpanAttributes): { key: string; value: Record<string, unknown> }[] {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") out.push({ key, value: { stringValue: value } });
    else if (typeof value === "boolean") out.push({ key, value: { boolValue: value } });
    else if (typeof value === "number") {
      // OTLP JSON encodes int64 as a string; doubles as a number.
      out.push(
        Number.isInteger(value)
          ? { key, value: { intValue: String(value) } }
          : { key, value: { doubleValue: value } },
      );
    }
  }
  return out;
}

function spanToOtlpSpan(span: Span): Record<string, unknown> {
  return {
    traceId: otlpTraceIdBytes(span.traceId).toString("base64"),
    spanId: Buffer.from(span.spanId, "hex").toString("base64"),
    ...(span.parentSpanId
      ? { parentSpanId: Buffer.from(span.parentSpanId, "hex").toString("base64") }
      : {}),
    name: span.name,
    kind: OTLP_KIND[span.kind],
    startTimeUnixNano: String(Math.round(span.startTime * 1e6)),
    endTimeUnixNano: String(Math.round((span.endTime ?? span.startTime) * 1e6)),
    attributes: otlpAttributes(span.attributes),
    status:
      span.status === "error"
        ? { code: 2, message: span.error ?? "error" }
        : { code: span.status === "ok" ? 1 : 0 },
  };
}

export interface OtlpExporterOptions {
  /** Base URL, e.g. `http://localhost:4318`. /v1/traces is appended. */
  endpoint: string;
  resource: SpanResource;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Flush when the buffer reaches this many spans. */
  batchSize?: number;
  /** Also flush after this many ms of quiet. */
  flushIntervalMs?: number;
}

export class OtlpJsonHttpExporter implements SpanExporter {
  private readonly endpoint: string;
  private readonly resource: SpanResource;
  private readonly fetchImpl: typeof fetch;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private buffer: Span[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: OtlpExporterOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "") + "/v1/traces";
    this.resource = opts.resource;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.batchSize = opts.batchSize ?? 8;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
  }

  export(span: Span): void {
    this.buffer.push(span);
    if (this.buffer.length >= this.batchSize) void this.flush();
    if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.send(batch);
    } catch (err) {
      // Never throw into the caller: an export failure must not fail the
      // request it is observing. Named with the first span's trace id so
      // the failure line joins the same trace as the spans it lost.
      const first = batch[0];
      console.error(
        JSON.stringify({
          correlation_id: first.traceId,
          trace_id: first.traceId,
          event: "otlp_export_failed",
          spans: batch.length,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async send(spans: Span[]): Promise<void> {
    const body = JSON.stringify(this.traceRequest(spans));
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`otlp endpoint returned ${res.status}`);
  }

  private traceRequest(spans: Span[]): Record<string, unknown> {
    const attributes = [
      { key: "service.name", value: { stringValue: this.resource["service.name"] } },
      ...(this.resource["service.version"]
        ? [{ key: "service.version", value: { stringValue: this.resource["service.version"] } }]
        : []),
      ...(this.resource["deployment.environment"]
        ? [
            {
              key: "deployment.environment",
              value: { stringValue: this.resource["deployment.environment"] },
            },
          ]
        : []),
    ];
    return {
      resourceSpans: [
        {
          resource: { attributes },
          scopeSpans: [
            {
              scope: { name: "ledgerlens.tracer", version: "0.1.0" },
              spans: spans.map(spanToOtlpSpan),
            },
          ],
        },
      ],
    };
  }
}
