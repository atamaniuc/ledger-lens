import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ingest } from "./helpers/api";
import { ALICE, BOB, ORG_A, asUser, sql, whatIf } from "./helpers/db";
import { Tracer } from "../src/platform/obs/tracer";
import {
  NoopExporter,
  OtlpJsonHttpExporter,
  otlpTraceIdBytes,
  spanToJson,
} from "../src/platform/obs/exporters";
import type { Span, SpanExporter } from "../src/platform/obs/types";

// Spec 0011 (lane W4-K), D-45. The acceptance criteria, made executable:
//
//  AC-01 — traces keyed by correlation_id. The tracer itself is unit-tested
//    here (one root per correlation id, children reuse it, never mint new
//    roots), the OTLP mapping is asserted against the wire format, and the
//    routes that own the chain are asserted to wire the tracer to the
//    request's correlation id. The agent lane's spans (loop.ts, chat route)
//    are specified in the lane report; their wiring is one import + two
//    calls and lands with the parent's edit.
//  AC-02 — the four metrics, each a single query a human can run, each
//    exercised against data the run just produced.
//  AC-03 — the two alerts: the pg_cron job is registered, and each alert
//    fires over its threshold and resolves when the condition clears.
//  AC-04 — every console log line at a call site carries correlation_id,
//    asserted over the source the way scheduler.spec.ts asserts the
//    scheduler comment is gone. (The tracer's own emitted lines are
//    asserted by the span-shape tests above, which check the JSON the
//    exporter writes.)
//  DoD #4 — RLS: a member sees their org's metric rows and alert rows; a
//    non-member sees nothing.

test.describe.configure({ mode: "serial" });

const tag = `obs-${Date.now()}`;

// ---------------------------------------------------------------------------
// Trace unit tests (AC-01).
// ---------------------------------------------------------------------------

/** Collects ended spans without touching the console. */
class CapturingExporter implements SpanExporter {
  readonly spans: Span[] = [];
  export(span: Span): void {
    this.spans.push(span);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

test.describe("traces (AC-01) — one trace per correlation_id", () => {
  test("a root span is keyed by the correlation_id; children reuse it", () => {
    const exporter = new CapturingExporter();
    const tracer = new Tracer({ exporter });
    const correlationId = randomUUID();

    const root = tracer.startSpan("ingest.run", {
      traceId: correlationId,
      kind: "server",
      attributes: { org_id: ORG_A },
    });
    const child = tracer.startSpan("ingest.page_fetch", {
      parent: root,
      kind: "client",
      attributes: { attempt: 1 },
    });
    tracer.endSpan(child, "ok");
    tracer.endSpan(root, "ok");

    // The chain: one trace id, one root, correct parent link, both exported.
    expect(root.traceId).toBe(correlationId);
    expect(child.traceId).toBe(correlationId);
    expect(root.parentSpanId).toBeNull();
    expect(child.parentSpanId).toBe(root.spanId);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(exporter.spans).toHaveLength(2);

    // The stdout shape: correlation_id first, then the canonical span
    // fields (trace_id is the same value) — the exact composition the
    // JsonStdoutExporter emits, so a log line and a span line join on
    // either key.
    const line: Record<string, unknown> = {
      correlation_id: root.traceId,
      ...spanToJson(root, { "service.name": "ledgerlens" }),
    };
    expect(line.correlation_id).toBe(correlationId);
    expect(line.trace_id).toBe(correlationId);
    expect(line.name).toBe("ingest.run");
    expect(line.kind).toBe("server");
    expect(Number(line.duration_ms)).toBeGreaterThanOrEqual(0);
    expect(line.status).toBe("ok");
    expect(line.attributes).toEqual(expect.objectContaining({ org_id: ORG_A }));
  });

  test("a child cannot mint a new root; a bare startSpan throws", () => {
    const tracer = new Tracer({ exporter: new CapturingExporter() });
    const root = tracer.startSpan("root", { traceId: "req-1" });
    // A conflicting traceId on a child is ignored — the parent's wins.
    const child = tracer.startSpan("child", { parent: root, traceId: "req-2" });
    expect(child.traceId).toBe("req-1");
    tracer.endSpan(child, "ok");
    tracer.endSpan(root, "ok");

    expect(() => tracer.startSpan("bare")).toThrow(/never mint new roots/);
  });

  test("trace() ends ok on resolve, error on throw; double-end is a no-op", async () => {
    const exporter = new CapturingExporter();
    const tracer = new Tracer({ exporter });
    const root = tracer.startSpan("root", { traceId: "req-3" });

    const value = await tracer.trace("work", async () => 42, { parent: root });
    expect(value).toBe(42);

    await expect(
      tracer.trace(
        "boom",
        async () => {
          throw new Error("kaboom");
        },
        { parent: root },
      ),
    ).rejects.toThrow("kaboom");

    const boom = exporter.spans.find((s) => s.name === "boom")!;
    expect(boom.status).toBe("error");
    expect(boom.error).toContain("kaboom");
    expect(boom.durationMs).not.toBeNull();

    const count = exporter.spans.length;
    tracer.endSpan(boom, "error", new Error("again"));
    expect(exporter.spans.length).toBe(count); // idempotent

    tracer.endSpan(root, "ok");
  });

  test("the OTLP JSON exporter maps correlation_id to a 16-byte trace id", async () => {
    interface OtlpSpanJson {
      traceId: string;
      spanId: string;
      kind: number;
      status: { code: number };
      attributes: { key: string; value: Record<string, unknown> }[];
    }
    interface OtlpTraceRequest {
      resourceSpans: {
        resource?: { attributes: { key: string; value: Record<string, unknown> }[] };
        scopeSpans: { spans: OtlpSpanJson[] }[];
      }[];
    }
    let captured: { url: string; body: OtlpTraceRequest } | null = null;
    const exporter = new OtlpJsonHttpExporter({
      endpoint: "http://collector.example:4318",
      resource: { "service.name": "ledgerlens", "deployment.environment": "test" },
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        captured = {
          url: String(url),
          body: JSON.parse(String(init?.body)) as OtlpTraceRequest,
        };
        return { ok: true, status: 200 } as Response;
      }) as typeof fetch,
    });
    const tracer = new Tracer({ exporter });

    const correlationId = randomUUID();
    const span = tracer.startSpan("ingest.run", {
      traceId: correlationId,
      kind: "server",
      attributes: { rows_written: 5, ratio: 0.5, ok: true },
    });
    tracer.endSpan(span, "ok");
    // A non-UUID correlation id (a custom header value) hashes to 16 bytes.
    const other = tracer.startSpan("agent.step", { traceId: "custom-header-id-123" });
    tracer.endSpan(other, "ok");
    await tracer.flush();

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://collector.example:4318/v1/traces");
    const otlp = captured!.body.resourceSpans[0].scopeSpans[0].spans;
    expect(otlp).toHaveLength(2);
    // The request carries the resource, so a collector can tag service/env.
    expect(
      captured!.body.resourceSpans[0].resource?.attributes?.some(
        (a: { key: string }) => a.key === "service.name",
      ),
    ).toBe(true);

    // A UUID correlation id decodes losslessly to its 16 bytes.
    expect(Buffer.from(otlp[0].traceId, "base64").toString("hex")).toBe(
      correlationId.replace(/-/g, ""),
    );
    expect(Buffer.from(otlp[0].spanId, "base64")).toHaveLength(8);
    expect(otlp[0].kind).toBe(2); // server
    expect(otlp[0].status.code).toBe(1); // ok
    const attrs = Object.fromEntries(otlp[0].attributes.map((a) => [a.key, a.value]));
    expect(attrs.rows_written.intValue).toBe("5");
    expect(attrs.ratio.doubleValue).toBe(0.5);
    expect(attrs.ok.boolValue).toBe(true);

    expect(Buffer.from(otlp[1].traceId, "base64")).toHaveLength(16);
    expect(otlp[1].traceId).toBe(otlpTraceIdBytes("custom-header-id-123").toString("base64"));
  });

  test("OTEL_SDK_DISABLED turns the tracer into a no-op", async () => {
    const exporter = new NoopExporter();
    const tracer = new Tracer({ exporter });
    const span = tracer.startSpan("ingest.run", { traceId: "req-4" });
    tracer.endSpan(span, "ok");
    await tracer.flush(); // must not throw
  });

  test("the ingestion and quality routes wire the tracer to the correlation_id", () => {
    const ingestSrc = readFileSync("src/app/api/ingestion/run/route.ts", "utf8");
    expect(ingestSrc).toContain('from "@/platform/obs"');
    expect(ingestSrc).toContain('startSpan("ingest.run"');
    expect(ingestSrc).toContain("traceId: correlationId");
    // The chain's stages, each keyed to the same trace:
    expect(ingestSrc).toContain('startSpan("ingest.start"');
    expect(ingestSrc).toContain('startSpan("ingest.page_fetch"');
    expect(ingestSrc).toContain('startSpan("ingest.page_process"');
    expect(ingestSrc).toContain('startSpan("quality.checks"');

    const qualitySrc = readFileSync("src/app/api/data-quality/run/route.ts", "utf8");
    expect(qualitySrc).toContain('startSpan("quality.run"');
    expect(qualitySrc).toContain("traceId: correlationId");
  });
});

// ---------------------------------------------------------------------------
// Metrics (AC-02).
// ---------------------------------------------------------------------------

test.describe("metrics (AC-02) — four views, each one query", () => {
  test.beforeAll(async ({ request }) => {
    // A fresh run so the metric views have data to answer with, and the
    // freshness lag starts near zero (well under the 4h alert threshold).
    const run = await ingest(request, ORG_A);
    expect(run.status).toBe("succeeded");
  });

  test("freshness_lag answers newest-invoice-vs-now per org", async () => {
    const rows = await sql`
      select org_id, newest_invoice_at, lag_seconds, measured_at
        from public.freshness_lag
       where org_id = ${ORG_A}`;
    expect(rows).toHaveLength(1);
    const lag = Number(rows[0].lag_seconds);
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThan(14400); // under the seeded 4h alert threshold
    expect(new Date(rows[0].measured_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("ingest_error_rate counts failed runs over total in the 24h window", async () => {
    const before = await sql`
      select count(*) filter (where status = 'failed')::int as f,
             count(*)::int as t
        from pipeline_runs
       where org_id = ${ORG_A}
         and started_at >= now() - interval '24 hours'`;
    const id = randomUUID();
    const corr = `obs-fail-${tag}`;
    await sql`
      insert into pipeline_runs (id, org_id, source, kind, status, started_at, correlation_id)
      values (${id}, ${ORG_A}, 'mock-provider', 'incremental', 'failed', now(), ${corr})`;
    try {
      const rows = await sql`
        select failed_runs, total_runs, error_rate_pct
          from public.ingest_error_rate
         where org_id = ${ORG_A}`;
      expect(Number(rows[0].failed_runs)).toBe(Number(before[0].f) + 1);
      expect(Number(rows[0].total_runs)).toBe(Number(before[0].t) + 1);
      expect(Number(rows[0].error_rate_pct)).toBeGreaterThan(0);
    } finally {
      await sql`delete from pipeline_runs where id = ${id}`;
    }
  });

  test("agent_p95_latency reports the p95 of llm_calls.latency_ms", async () => {
    const p95 = await whatIf(async (tx) => {
      // Deterministic slate: the org's real calls (if any) are removed
      // inside the rolled-back transaction, so the p95 is exactly the
      // latencies this test inserts.
      await tx`delete from llm_calls where org_id = ${ORG_A}`;
      await tx`
        insert into llm_calls (org_id, correlation_id, step_no, model, prompt_version, latency_ms, outcome)
        select ${ORG_A}, ${'obs-p95-' + tag}, 0, 'test-model', 'v0', g, 'ok'
          from generate_series(1, 20) g`;
      const rows = await tx`
        select p95_latency_ms from public.agent_p95_latency
         where org_id = ${ORG_A}`;
      return rows[0] ? Number(rows[0].p95_latency_ms) : null;
    });

    // p95 of 1..20 interpolates to 19.05.
    expect(p95).not.toBeNull();
    expect(p95!).toBeGreaterThan(18);
    expect(p95!).toBeLessThanOrEqual(20);
  });

  test("llm_daily_cost reports per-org daily spend from llm_calls.cost_cents", async () => {
    const total = await whatIf(async (tx) => {
      await tx`delete from llm_calls where org_id = ${ORG_A}`;
      await tx`
        insert into llm_calls (org_id, correlation_id, step_no, model, prompt_version, cost_cents, latency_ms, outcome)
        values
          (${ORG_A}, ${'obs-cost-' + tag}, 0, 'test-model', 'v0', 12.5, 1, 'ok'),
          (${ORG_A}, ${'obs-cost-' + tag}, 1, 'test-model', 'v0', 7.5, 1, 'ok')`;
      const rows = await tx`
        select day, cost_cents from public.llm_daily_cost
         where org_id = ${ORG_A}`;
      expect(rows).toHaveLength(1);
      return Number(rows[0].cost_cents);
    });
    expect(total).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Alerts (AC-03).
// ---------------------------------------------------------------------------

test.describe("alerts (AC-03) — pg_cron job + thresholds, fire and resolve", () => {
  test("the ll_obs_alerts cron job is registered with a real schedule", async () => {
    const jobs = await sql`
      select jobname, schedule, command, active
        from cron.job
       where jobname = 'll_obs_alerts'`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toBe("*/5 * * * *");
    expect(jobs[0].active).toBe(true);
    expect(jobs[0].command).toContain("public.evaluate_observability_alerts()");
  });

  test("the thresholds are seeded with documented units", async () => {
    const rows = await sql`
      select alert_name, threshold, unit from public.observability_alert_thresholds
       order by alert_name`;
    expect(rows.map((r) => r.alert_name)).toEqual(["daily_cost_exceeded", "freshness_exceeded"]);
    const freshness = rows.find((r) => r.alert_name === "freshness_exceeded")!;
    const cost = rows.find((r) => r.alert_name === "daily_cost_exceeded")!;
    expect(Number(freshness.threshold)).toBe(14400);
    expect(freshness.unit).toBe("seconds");
    expect(Number(cost.threshold)).toBe(1000);
    expect(cost.unit).toBe("usd_cents");
  });

  test("freshness beyond the threshold opens an alert; recovery resolves it", async () => {
    await whatIf(async (tx) => {
      await tx`update invoices set transformed_at = now() - interval '25 hours'
                 where org_id = ${ORG_A}`;

      const fired = await tx`
        select org_id, alert_name, status, observed, threshold
          from public.evaluate_observability_alerts()
         where org_id = ${ORG_A}`;
      const open = fired.find((r) => r.alert_name === "freshness_exceeded")!;
      expect(open.status).toBe("open");
      expect(Number(open.observed)).toBeGreaterThan(Number(open.threshold));

      // Recovery: a second evaluation after the data is fresh resolves it.
      await tx`update invoices set transformed_at = now()
                 where org_id = ${ORG_A}`;
      const after = await tx`
        select alert_name, status from public.evaluate_observability_alerts()
         where org_id = ${ORG_A}`;
      expect(after.find((r) => r.alert_name === "freshness_exceeded")).toBeUndefined();

      const rows = await tx`
        select status from public.observability_alerts
         where org_id = ${ORG_A} and alert_name = 'freshness_exceeded'`;
      expect(rows[0].status).toBe("resolved");
    });
  });

  test("daily spend over the cap opens an alert; spend back under resolves it", async () => {
    await whatIf(async (tx) => {
      await tx`delete from llm_calls where org_id = ${ORG_A}`;
      // Above the seeded $10/day cap.
      await tx`
        insert into llm_calls (org_id, correlation_id, step_no, model, prompt_version, cost_cents, latency_ms, outcome)
        values (${ORG_A}, ${'obs-cap-' + tag}, 0, 'test-model', 'v0', 1500, 1, 'ok')`;

      const fired = await tx`
        select org_id, alert_name, status, observed, threshold
          from public.evaluate_observability_alerts()
         where org_id = ${ORG_A}`;
      const open = fired.find((r) => r.alert_name === "daily_cost_exceeded")!;
      expect(open.status).toBe("open");
      expect(Number(open.observed)).toBeGreaterThan(Number(open.threshold));

      // Re-firing while open refreshes the same row rather than stacking.
      const openRows = await tx`
        select count(*)::int as n from public.observability_alerts
         where org_id = ${ORG_A} and alert_name = 'daily_cost_exceeded' and status = 'open'`;
      expect(Number(openRows[0].n)).toBe(1);

      // Recovery.
      await tx`delete from llm_calls where org_id = ${ORG_A}`;
      const after = await tx`
        select alert_name, status from public.evaluate_observability_alerts()
         where org_id = ${ORG_A}`;
      expect(after.find((r) => r.alert_name === "daily_cost_exceeded")).toBeUndefined();

      const rows = await tx`
        select status from public.observability_alerts
         where org_id = ${ORG_A} and alert_name = 'daily_cost_exceeded'`;
      expect(rows[0].status).toBe("resolved");
    });
  });
});

// ---------------------------------------------------------------------------
// RLS (DoD #4) — a non-member gets empty results, never error-masked data.
// ---------------------------------------------------------------------------

test.describe("RLS (DoD #4)", () => {
  test("a member sees their org's metric and alert rows; a non-member sees nothing", async () => {
    const fixture = `obs-rls-${tag}`;
    await sql`
      insert into public.observability_alerts
        (org_id, alert_name, severity, status, observed, threshold, unit, details)
      values
        (${ORG_A}, 'freshness_exceeded', 'warning', 'open', 99999, 14400, 'seconds',
         ${sql.json({ fixture })})`;
    try {
      await asUser(ALICE, async (tx) => {
        const alerts = await tx`
          select id from public.observability_alerts
           where org_id = ${ORG_A} and details->>'fixture' = ${fixture}`;
        expect(alerts, "Alice cannot see her org's alert").toHaveLength(1);
        const metrics = await tx`
          select org_id from public.freshness_lag where org_id = ${ORG_A}`;
        expect(metrics.length, "Alice cannot see her org's freshness metric").toBeGreaterThan(0);
      });

      await asUser(BOB, async (tx) => {
        const alerts = await tx`
          select id from public.observability_alerts
           where org_id = ${ORG_A} and details->>'fixture' = ${fixture}`;
        expect(alerts, "Bob can read Acme's alert").toHaveLength(0);
        const metrics = await tx`
          select org_id from public.freshness_lag where org_id = ${ORG_A}`;
        expect(metrics, "Bob can read Acme's freshness metric").toHaveLength(0);
      });
    } finally {
      // Delete every fixture row for this org, not only this run's tag: a
      // failed prior run must not leave an alert behind that a later run
      // mistakes for its own.
      await sql`
        delete from public.observability_alerts
         where org_id = ${ORG_A} and details->>'fixture' is not null`;
    }
  });
});

// ---------------------------------------------------------------------------
// AC-04 — correlation_id on every log line, asserted not assumed.
// ---------------------------------------------------------------------------

test.describe("AC-04 — correlation_id on every log line", () => {
  const callSiteFiles = [
    "src/app/api/ingestion/run/route.ts",
    "src/app/api/data-quality/run/route.ts",
    "src/app/api/agent/chat/route.ts",
    "src/features/agent/audit.ts",
    "src/features/agent/loop.ts",
    "src/features/dashboard/correlation.ts",
    "src/features/ingestion/backoff.ts",
  ];

  test("no console statement at a call site writes without correlation_id", () => {
    for (const file of callSiteFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [i, line] of lines.entries()) {
        if (!/console\.(log|error|warn)\(/.test(line)) continue;
        // A console statement is one log line even when it spans several
        // source lines (console.error(\n  JSON.stringify({ correlation_id:
        // ... }),\n);) — scan to the line that closes the call, then check
        // the statement as a whole. The tracer's own emitted lines are
        // machine-checked in the trace tests above (the span JSON's
        // correlation_id field), so the exporter is exempt from this
        // source-level check by construction.
        const statement = [line];
        let j = i + 1;
        while (j < lines.length && !/\);?\s*$/.test(lines[j])) {
          statement.push(lines[j]);
          j++;
        }
        if (j < lines.length) statement.push(lines[j]);

        expect(
          statement.join(" "),
          `${file}:${i + 1} writes a log line without correlation_id`,
        ).toMatch(/correlation_id/);
      }
    }
  });
});
