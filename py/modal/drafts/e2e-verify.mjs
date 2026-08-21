// One-off e2e verification for the transcribe-webhook function (spec 0009).
// Run against the isolated server (port 8000) while the shared edge runtime
// is busy: signed success, content-keyed duplicate, replay refusal, wrong
// secret, malformed transcript quarantine, then SQL assertions + cleanup.
// This is the logic the parent's tests/transcribe-idempotency.spec.ts wraps.

import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const FUNC = process.env.TRANSCRIBE_URL ?? "http://127.0.0.1:8000/";
const SECRET = process.env.WEBHOOK_SHARED_SECRET;
const ORG = "00000000-0000-4000-8000-000000000002"; // Globex Inc (ORG_B)

const DB = [
  "psql", "-h", "127.0.0.1", "-p", "54322", "-U", "postgres", "-d", "postgres", "-t", "-A",
];
const q = (sql) => execFileSync("psql", [...DB.slice(1), "-c", sql], {
  env: { ...process.env, PGPASSWORD: "postgres" },
}).toString().trim();

const tag = `e2e-${Date.now()}`;
const audio = Buffer.from(`audio-bytes-${tag}`);
const audioHash = createHmac("sha256", "k").update(audio).digest("hex"); // placeholder below
import { createHash } from "node:crypto";
const audioHashReal = createHash("sha256").update(audio).digest("hex");

function sign(secret, ts, nonce, rawBody) {
  return createHmac("sha256", secret).update(`v1:${ts}:${nonce}:${rawBody}`).digest("hex");
}

function envelope(payload, opts = {}) {
  const rawBody = JSON.stringify(payload);
  const ts = opts.ts ?? Date.now();
  const nonce = opts.nonce ?? randomUUID();
  const headers = {
    "content-type": "application/json",
    "x-webhook-timestamp": String(ts),
    "x-webhook-nonce": nonce,
    "x-webhook-signature": opts.signature ?? sign(opts.secret ?? SECRET, ts, nonce, rawBody),
  };
  return { headers, rawBody };
}

async function post(env) {
  const res = await fetch(FUNC, { method: "POST", headers: env.headers, body: env.rawBody });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

function payload(audioHashVal, overrides = {}) {
  return {
    org_id: ORG,
    source: "transcription",
    event: {
      audio_hash: audioHashVal,
      recorded_at: today,
      duration_seconds: 5.0,
      model: "stub-whisper",
      transcript: {
        text: "Good morning. Thank you for coming in today.",
        language: "en",
        segments: [
          { start: 0.0, end: 2.0, text: "Good morning." },
          { start: 2.0, end: 5.0, text: "Thank you for coming in today." },
        ],
      },
    },
    ...overrides,
  };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

// 1. Valid signed transcript -> succeeded + document + raw event + run
const p1 = payload(audioHashReal);
const r1 = await post(envelope(p1, { correlationId: `corr-${tag}-1` }));
check("valid signed request accepted", r1.status === 200 && r1.body?.status === "succeeded", JSON.stringify(r1.body));

const docCount = q(`select count(*) from documents d join raw_events e on e.id = d.raw_event_id where e.external_id = '${audioHashReal}' and e.org_id = '${ORG}'`);
check("exactly one document created", docCount === "1", `documents=${docCount}`);

const docRow = q(`select d.kind || '|' || (d.run_id is not null)::text || '|' || (d.raw_event_id is not null)::text from documents d join raw_events e on e.id = d.raw_event_id where e.external_id = '${audioHashReal}'`);
check("document kind=transcript with run_id and raw_event_id", docRow === "transcript|true|true", docRow);

const runRow = q(`select r.kind || '|' || r.source || '|' || (r.correlation_id is not null)::text from pipeline_runs r join raw_events e on e.run_id = r.id where e.external_id = '${audioHashReal}'`);
check("run kind=webhook source=transcription with correlation_id", runRow === "webhook|transcription|true", runRow);

const bodyCheck = q(`select e.payload->'transcript'->>'text' from raw_events e where e.external_id = '${audioHashReal}'`);
check("raw_events payload holds the transcript", bodyCheck.includes("Good morning"), bodyCheck.slice(0, 40));

// 2. Same audio again, fresh nonce -> duplicate, still one document
const r2 = await post(envelope(payload(audioHashReal)));
check("same audio redelivered -> duplicate", r2.status === 200 && r2.body?.status === "duplicate", JSON.stringify(r2.body));
const docCount2 = q(`select count(*) from documents d join raw_events e on e.id = d.raw_event_id where e.external_id = '${audioHashReal}'`);
check("still exactly one document after redelivery", docCount2 === "1", `documents=${docCount2}`);

// 3. Identical signed envelope replayed -> 401 (nonce single-use)
const envReplay = envelope(payload(audioHashReal));
await post(envReplay);
const r3 = await post(envReplay);
check("identical signed request replayed -> 401", r3.status === 401, `status=${r3.status}`);

// 4. Wrong secret -> 401
const r4 = await post(envelope(payload(audioHashReal), { secret: "not-the-shared-secret" }));
check("wrong secret -> 401", r4.status === 401, `status=${r4.status}`);

// 5. Future recorded_at -> quarantined with reason
const futureHash = createHash("sha256").update(Buffer.from(`future-${tag}`)).digest("hex");
const r5 = await post(envelope(payload(futureHash, { event: { audio_hash: futureHash, recorded_at: tomorrow, duration_seconds: 5.0, model: "stub-whisper", transcript: { text: "Good morning.", language: "en", segments: [{ start: 0, end: 1, text: "Good morning." }] } } })));
check("impossible future date -> quarantined", r5.status === 200 && r5.body?.status === "quarantined" && r5.body?.quarantine_reason?.includes("future_dated"), JSON.stringify(r5.body));
const qRows = q(`select count(*) from quarantine q join raw_events e on e.id = q.raw_event_id where e.external_id = '${futureHash}'`);
check("quarantine row written", qRows === "1", `quarantine=${qRows}`);

// 6. Malformed content (empty text) -> quarantined with schema reason
const emptyHash = createHash("sha256").update(Buffer.from(`empty-${tag}`)).digest("hex");
const r6 = await post(envelope(payload(emptyHash, { event: { audio_hash: emptyHash, recorded_at: today, duration_seconds: 5.0, model: "stub-whisper", transcript: { text: "   ", language: "en", segments: [] } } })));
check("empty transcript text -> quarantined", r6.status === 200 && r6.body?.status === "quarantined" && r6.body?.quarantine_reason?.includes("schema_validation_failed"), JSON.stringify(r6.body));

// 7. Missing signature -> 401
const r7 = await post({ headers: { "content-type": "application/json" }, rawBody: JSON.stringify(payload(audioHashReal)) });
check("unsigned request -> 401", r7.status === 401, `status=${r7.status}`);

// Cleanup — delete exactly what this run created (children first).
q(`delete from documents d using raw_events e where d.raw_event_id = e.id and e.org_id = '${ORG}' and e.external_id in ('${audioHashReal}','${futureHash}','${emptyHash}')`);
q(`delete from quarantine q using raw_events e where q.raw_event_id = e.id and e.org_id = '${ORG}' and e.external_id in ('${audioHashReal}','${futureHash}','${emptyHash}')`);
q(`delete from raw_events where org_id = '${ORG}' and external_id in ('${audioHashReal}','${futureHash}','${emptyHash}')`);
q(`delete from pipeline_runs r where r.org_id = '${ORG}' and r.kind = 'webhook' and r.source = 'transcription' and r.correlation_id like 'corr-%${tag}%'`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);