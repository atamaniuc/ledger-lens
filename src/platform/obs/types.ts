// Hand-rolled OTel-compatible span types (spec 0011, lane W4-K).
//
// Why this exists and no @opentelemetry/api import sits at the top:
// the lane constraint forbids adding npm dependencies, and OpenTelemetry's
// own SDK pulls in a dependency tree this project is not allowed to grow.
// The span shape below is the intersection of what the OTel spec requires
// (trace_id, span_id, parent_span_id, name, kind, timestamps, status,
// attributes, resource) and what this codebase needs (trace_id ===
// correlation_id so a span line and a log line join by one field). A
// hand-rolled span that is documented beats a dependency we were told not
// to add; if the constraint ever lifts, the preferred dependency is
// `@opentelemetry/api` (plus `@opentelemetry/exporter-trace-otlp-http`
// for the OTLP exporter) behind this same interface.

/** Span kind, mapped to the OTLP numeric enum on export. */
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

/** "ok" is an explicit OK status; "error" carries an error message. */
export type SpanStatus = "ok" | "error";

export type SpanAttributeValue = string | number | boolean | null | undefined;
export type SpanAttributes = Record<string, SpanAttributeValue>;

/** Resource attributes attached to every exported span. */
export interface SpanResource {
  "service.name": string;
  "service.version"?: string;
  "deployment.environment"?: string;
}

/**
 * A completed span, as the exporters see it. Immutable except for
 * `setAttribute` before `end`; `end` is idempotent (a second call is a
 * no-op) and is what hands the span to the exporter.
 */
export interface Span {
  /** The correlation_id. Never minted inside the tracer — see tracer.ts. */
  readonly traceId: string;
  /** 16 hex chars (8 random bytes). */
  readonly spanId: string;
  /** 16 hex chars, or null for a root span. */
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: SpanKind;
  /** Epoch milliseconds. */
  readonly startTime: number;
  readonly endTime: number | null;
  readonly durationMs: number | null;
  readonly status: SpanStatus | null;
  readonly error: string | null;
  readonly attributes: SpanAttributes;

  setAttribute(name: string, value: SpanAttributeValue): void;
  end(status?: SpanStatus, error?: unknown): void;
}

/** A sink for completed spans. Exporters must never throw into their caller. */
export interface SpanExporter {
  export(span: Span): void;
  flush(): Promise<void>;
}
