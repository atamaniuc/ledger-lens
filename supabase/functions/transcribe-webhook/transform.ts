// Transcript validation + document rendering for the transcribe-webhook Edge
// Function (spec 0009, D-42). Pure logic, no I/O, no runtime-specific
// imports — the same shareability rule as
// src/features/ingestion/transform.ts (ADR 0002).
//
// This is the gate: a transcript that fails here is quarantined by the same
// raw_events/quarantine machinery every other source uses, with a reason.
// The producer-side mirror lives in
// py/modal/modal_transcription/contract.py (spec 0009) — every constant and
// every reason string below is kept in lockstep with it, and the pytest
// suite in py/modal asserts both sides of every decision.
//
// The "impossible date" rule is D-15's, applied to a recording: recorded_at
// may be today at the latest.

import { sha256Hex } from "../../../src/platform/hash.ts";

export const MAX_TRANSCRIPT_CHARS = 250_000;
export const MAX_SEGMENTS = 10_000;
// A recording longer than a day is not a recording.
export const MAX_DURATION_SECONDS = 24 * 60 * 60;
// Whisper's own output has contiguous segments; a tiny overlap tolerance
// keeps a rounding artifact from being treated as malformed, nothing more.
export const SEGMENT_OVERLAP_TOLERANCE_SECONDS = 0.05;
// The last segment's end may run a hair past the reported duration.
export const DURATION_TOLERANCE_SECONDS = 1.0;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LANG_RE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const AUDIO_HASH_RE = /^[0-9a-f]{64}$/;

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptEvent {
  audio_hash: string;
  recorded_at: string;
  duration_seconds: number;
  model: string;
  transcript: {
    text: string;
    language: string;
    segments: TranscriptSegment[];
  };
}

export type TranscriptTransformResult =
  | {
      ok: true;
      event: TranscriptEvent;
      /** The timestamped document body that lands in documents.body. */
      body: string;
      /** sha256 hex of body — what documents.content_hash stores. */
      content_hash: string;
      /** Deterministic per audio_hash, so (org_id, title) stays unique. */
      title: string;
    }
  | { ok: false; reason: string; details?: unknown };

function segmentError(index: number, message: string) {
  return {
    ok: false as const,
    reason: `invalid_timing: segment ${index} ${message}`,
    details: { segment: index },
  };
}

/** HH:MM:SS.mmm (or MM:SS.mmm under an hour), matching Whisper's convention. */
export function formatTimestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  const mmm = String(milli).padStart(3, "0");
  return h > 0 ? `${h}:${mm}:${ss}.${mmm}` : `${mm}:${ss}.${mmm}`;
}

/** The timestamped transcript: one "[start --> end] text" line per segment. */
export function renderTranscriptBody(segments: TranscriptSegment[], fallbackText?: string): string {
  if (segments.length === 0) return fallbackText ?? "";
  return segments
    .map((seg) => `[${formatTimestamp(seg.start)} --> ${formatTimestamp(seg.end)}] ${seg.text}`)
    .join("\n");
}

export async function validateTranscript(
  raw: unknown,
  options: { today?: Date } = {},
): Promise<TranscriptTransformResult> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "schema_validation_failed: transcript required" };
  }
  const body = raw as Record<string, unknown>;

  const audioHash = body.audio_hash;
  if (typeof audioHash !== "string" || !AUDIO_HASH_RE.test(audioHash)) {
    return { ok: false, reason: "schema_validation_failed: audio_hash must be a 64-char sha256 hex" };
  }

  const recordedAt = body.recorded_at;
  if (typeof recordedAt !== "string" || !DATE_RE.test(recordedAt)) {
    return { ok: false, reason: "schema_validation_failed: recorded_at must be YYYY-MM-DD" };
  }
  const today = (options.today ?? new Date()).toISOString().slice(0, 10);
  if (recordedAt > today) {
    return {
      ok: false,
      reason: `future_dated: recorded_at=${recordedAt} is after today (${today})`,
      details: { recorded_at: recordedAt, today },
    };
  }

  const duration = body.duration_seconds;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return { ok: false, reason: "schema_validation_failed: duration_seconds must be a positive number" };
  }
  if (duration > MAX_DURATION_SECONDS) {
    return {
      ok: false,
      reason: `invalid_duration: duration_seconds=${duration} exceeds ${MAX_DURATION_SECONDS}`,
    };
  }

  const model = body.model;
  if (typeof model !== "string" || model.length === 0) {
    return { ok: false, reason: "schema_validation_failed: model must be a non-empty string" };
  }

  const transcript = body.transcript;
  if (!transcript || typeof transcript !== "object") {
    return { ok: false, reason: "schema_validation_failed: transcript required" };
  }
  const t = transcript as Record<string, unknown>;

  const text = t.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, reason: "schema_validation_failed: transcript.text must be a non-empty string" };
  }
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    return {
      ok: false,
      reason: `transcript_too_long: text length ${text.length} exceeds ${MAX_TRANSCRIPT_CHARS}`,
    };
  }

  const language = t.language;
  if (typeof language !== "string" || !LANG_RE.test(language)) {
    return { ok: false, reason: "schema_validation_failed: transcript.language invalid" };
  }

  const segmentsRaw = t.segments;
  if (!Array.isArray(segmentsRaw)) {
    return { ok: false, reason: "schema_validation_failed: transcript.segments must be an array" };
  }
  if (segmentsRaw.length > MAX_SEGMENTS) {
    return { ok: false, reason: `too_many_segments: ${segmentsRaw.length} exceeds ${MAX_SEGMENTS}` };
  }

  const segments: TranscriptSegment[] = [];
  let prevEnd = 0;
  for (let i = 0; i < segmentsRaw.length; i++) {
    const seg = segmentsRaw[i];
    if (!seg || typeof seg !== "object") return segmentError(i, "must be an object");
    const s = seg as Record<string, unknown>;
    const { start, end } = s;
    const segText = s.text;
    if (typeof start !== "number" || !Number.isFinite(start)) return segmentError(i, "start must be a number");
    if (typeof end !== "number" || !Number.isFinite(end)) return segmentError(i, "end must be a number");
    if (start < 0) return segmentError(i, "start is negative");
    if (end <= start) return segmentError(i, "end not after start");
    if (start < prevEnd - SEGMENT_OVERLAP_TOLERANCE_SECONDS) {
      return segmentError(i, "overlaps previous segment");
    }
    if (end > duration + DURATION_TOLERANCE_SECONDS) return segmentError(i, "end exceeds reported duration");
    if (typeof segText !== "string") return segmentError(i, "text must be a string");
    segments.push({ start, end, text: segText });
    prevEnd = end;
  }

  const event: TranscriptEvent = {
    audio_hash: audioHash,
    recorded_at: recordedAt,
    duration_seconds: duration,
    model,
    transcript: { text, language, segments },
  };
  const bodyText = renderTranscriptBody(segments, text);
  return {
    ok: true,
    event,
    body: bodyText,
    content_hash: await sha256Hex(bodyText),
    title: `Transcribed audio ${audioHash.slice(0, 12)}`,
  };
}