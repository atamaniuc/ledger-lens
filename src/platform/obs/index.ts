// Public surface of the observability package (spec 0011, lane W4-K).
//
// One process singleton, configured once from env:
//   * OTEL_SDK_DISABLED=1|true          -> no-op (spans cost nothing)
//   * OTEL_EXPORTER_OTLP_ENDPOINT set   -> OTLP/HTTP JSON export
//   * otherwise                         -> structured JSON to stdout
//
// The stdout default is the point: Vercel and `docker logs` collect it with
// zero configuration, and every emitted line carries the correlation_id as
// the trace id, so an existing log grep and a trace join on one field.
//
// Module-level convenience functions mirror the Tracer methods so call
// sites (routes, the agent lane) can `import { trace } from "@/platform/obs"`
// without threading a tracer instance around.

import { JsonStdoutExporter, NoopExporter, OtlpJsonHttpExporter } from "./exporters";
import { Tracer, type StartSpanOptions, type TraceOptions } from "./tracer";
import type { Span, SpanExporter, SpanStatus } from "./types";

export type {
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanExporter,
  SpanKind,
  SpanResource,
  SpanStatus,
} from "./types";
export type { StartSpanOptions, TraceOptions } from "./tracer";

let singleton: Tracer | null = null;

export function getTracer(): Tracer {
  singleton ??= createTracer();
  return singleton;
}

function createTracer(): Tracer {
  const resource = {
    "service.name": process.env.OTEL_SERVICE_NAME ?? "ledgerlens",
    "service.version": process.env.OTEL_SERVICE_VERSION,
    "deployment.environment": process.env.NODE_ENV ?? "development",
  };

  const disabled = ["1", "true"].includes((process.env.OTEL_SDK_DISABLED ?? "").toLowerCase());
  let exporter: SpanExporter;
  if (disabled) {
    exporter = new NoopExporter();
  } else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    exporter = new OtlpJsonHttpExporter({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      resource,
    });
  } else {
    exporter = new JsonStdoutExporter(resource);
  }

  return new Tracer({ exporter });
}

/** Start a span on the process singleton. See Tracer.startSpan. */
export function startSpan(name: string, opts?: StartSpanOptions): Span {
  return getTracer().startSpan(name, opts);
}

/** End a span on the process singleton. Idempotent. */
export function endSpan(span: Span, status?: SpanStatus, error?: unknown): void {
  getTracer().endSpan(span, status, error);
}

/** Run fn under a span that ends "ok" on resolve, "error" on throw. */
export function trace<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  opts?: TraceOptions,
): Promise<T> {
  return getTracer().trace(name, fn, opts);
}

/** Flush the singleton's exporter (no-op for stdout). Never throws. */
export function flush(): Promise<void> {
  return getTracer().flush();
}
