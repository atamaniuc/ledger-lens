// The tracer (spec 0011, lane W4-K).
//
// Explicit-parent spans, no async-context magic. A span is started with
// either an explicit `parent` or a `traceId` — never both, and never
// neither: the project invariant is that every log line carries a
// correlation_id, so every trace is keyed by one too, and a span that tries
// to mint its own root throws. Children always inherit the parent's trace
// id; a conflicting `traceId` on a child is ignored. This is the honest
// minimal shape: no AsyncLocalStorage, no ambient context, one object the
// caller owns and ends. The alternative (ALS) would hide the wiring, and
// hidden wiring is exactly what a hand-rolled tracer must not have.
//
// The span id is 8 random bytes. The trace id is the correlation_id
// verbatim for the stdout exporter; the OTLP exporter maps it to the 16
// bytes OTLP requires (see exporters.ts).

import { randomBytes } from "node:crypto";
import type {
  Span,
  SpanAttributeValue,
  SpanAttributes,
  SpanExporter,
  SpanKind,
  SpanStatus,
} from "./types";

export interface StartSpanOptions {
  /**
   * The correlation_id this trace is keyed by. Required for a root span;
   * ignored (the parent's wins) when `parent` is given.
   */
  traceId?: string;
  /** The span this one is a child of. Children never mint new roots. */
  parent?: Span;
  kind?: SpanKind;
  attributes?: SpanAttributes;
  /** Epoch ms. Defaults to now. Only meaningful for deterministic tests. */
  startTime?: number;
}

export type TraceOptions = StartSpanOptions;

class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTime: number;
  endTime: number | null = null;
  durationMs: number | null = null;
  status: SpanStatus | null = null;
  error: string | null = null;
  attributes: SpanAttributes;

  constructor(
    opts: {
      traceId: string;
      spanId: string;
      parentSpanId: string | null;
      name: string;
      kind: SpanKind;
      startTime: number;
      attributes: SpanAttributes;
    },
    private readonly exporter: SpanExporter,
  ) {
    this.traceId = opts.traceId;
    this.spanId = opts.spanId;
    this.parentSpanId = opts.parentSpanId;
    this.name = opts.name;
    this.kind = opts.kind;
    this.startTime = opts.startTime;
    this.attributes = { ...opts.attributes };
  }

  setAttribute(name: string, value: SpanAttributeValue): void {
    if (this.endTime !== null) return; // frozen after end
    this.attributes[name] = value;
  }

  end(status: SpanStatus = "ok", error?: unknown): void {
    if (this.endTime !== null) return; // idempotent
    this.endTime = Date.now();
    this.durationMs = this.endTime - this.startTime;
    this.status = status;
    this.error = error == null ? null : error instanceof Error ? error.message : String(error);
    this.exporter.export(this);
  }
}

export class Tracer {
  constructor(private readonly opts: { exporter: SpanExporter }) {}

  /**
   * Starts a span. Requires a `parent` or a `traceId` (the
   * correlation_id) — spans never mint new roots.
   */
  startSpan(name: string, opts: StartSpanOptions = {}): Span {
    const parent = opts.parent;
    let traceId: string;
    let parentSpanId: string | null;
    if (parent) {
      traceId = parent.traceId;
      parentSpanId = parent.spanId;
    } else if (opts.traceId) {
      traceId = opts.traceId;
      parentSpanId = null;
    } else {
      throw new Error(
        "startSpan requires a parent span or an explicit traceId (the correlation_id): " +
          "spans never mint new roots",
      );
    }

    return new SpanImpl(
      {
        traceId,
        spanId: randomBytes(8).toString("hex"),
        parentSpanId,
        name,
        kind: opts.kind ?? "internal",
        startTime: opts.startTime ?? Date.now(),
        attributes: opts.attributes ?? {},
      },
      this.opts.exporter,
    );
  }

  endSpan(span: Span, status: SpanStatus = "ok", error?: unknown): void {
    span.end(status, error);
  }

  /**
   * Runs `fn`, ending the span "ok" on resolve and "error" on throw
   * (re-throwing). The span is passed to `fn` so a caller can enrich it
   * mid-flight.
   */
  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    opts: TraceOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, opts);
    try {
      const result = await fn(span);
      span.end("ok");
      return result;
    } catch (err) {
      span.end("error", err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Flushes the exporter (a no-op for the stdout exporter). Never throws. */
  async flush(): Promise<void> {
    try {
      await this.opts.exporter.flush();
    } catch {
      // An export failure must not fail the request it is observing.
    }
  }
}
