"use client";

import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { segmentAnswer, type Citation } from "@/features/agent/citations";
import type { AgentTurnResult } from "@/features/agent/loop";
import { fetchInvoiceLineage } from "@/features/dashboard/queries";
import { createClient } from "@/platform/supabase/browser-client";
import { EmptyState, Panel, PanelError } from "@/components/ui/status-badge";
import { useSelection } from "./selection-context";

// US-07. The copilot: ask a question, get an answer built from this org's own
// rows, with every claim traceable back to what the agent actually read.
//
// Spec 0013 adds the two things that make the panel feel alive rather than
// stuck: the request is sent with `Accept: text/event-stream`, and step
// events (a tool starting, its result summary, token deltas) are rendered as
// they arrive — so a two-step turn shows its steps instead of nothing — and
// a Cancel button aborts the fetch, which the server audits as `cancelled`
// rather than as an answer.
//
// The panel is deliberately dull. Everything that decides whether an answer
// can be trusted was settled server-side — RLS scopes retrieval, the tool
// registry bounds what the agent can do, and citations are checked against
// what a tool really returned (ADR 0009). This file's whole job is to show
// the result of those decisions rather than to make any of its own. In
// particular it never hides a flagged answer: an unverified citation is
// rendered, marked, and left in place.
//
// The request runs through TanStack Query's `useMutation`, which is what owns
// the pending/settled state. What this file still owns is the *shape* of a
// settled response: a 503 is an unconfigured deployment rather than a failed
// question, and a 200 whose body is not an answer is a failure — neither is
// something the transport can tell apart on its own.

type AgentResponse = AgentTurnResult & { correlation_id: string; demo?: boolean };

/**
 * One progressive event the server sends before the final answer (AC-01).
 * Mirrors the loop's AgentStepEvent, kept here so the panel never imports
 * server internals it does not own the shape of.
 */
type StreamStepEvent =
  | { type: "step"; stepNo: number; tool: string; args: unknown }
  | { type: "tool_result"; stepNo: number; tool: string; summary: string }
  | { type: "tokens"; text: string };

interface AskOptions {
  /** Abort to cancel the running turn; the server audits it as cancelled. */
  signal: AbortSignal;
  /** Forwarded as events arrive, so the panel can render the turn as it runs. */
  onStep: (event: StreamStepEvent) => void;
  /** This page's conversation, so a follow-up sees the prior turn (AC-03). */
  conversationId: string;
}

export type AskQuestion = (question: string, options: AskOptions) => Promise<AgentResponse>;

/**
 * An operator problem, not the reader's. Carried as its own error type so the
 * panel does not render "the copilot failed to answer your question" over a
 * deployment that was never given a key.
 */
export class UnconfiguredError extends Error {}

export class TurnError extends Error {
  readonly correlationId: string | null;

  constructor(message: string, correlationId: string | null) {
    super(message);
    this.correlationId = correlationId;
  }
}

/**
 * The model provider said to come back later. Its own state, because "wait
 * twenty seconds" and "something went wrong" are different instructions to a
 * reader, and free tiers make the first one routine.
 */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The reader cancelled the turn (AC-02). Distinct from every failure: nothing
 * went wrong, the answer was simply not wanted, and the audit trail already
 * says so.
 */
export class TurnCancelledError extends Error {}

/** 1627 seconds is true and unreadable; "about 27 minutes" is what a person wants. */
function humanize(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "an hour" : `about ${hours} hours`;
  }
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? "a minute" : `about ${minutes} minutes`;
  }
  return `about ${seconds} seconds`;
}

function errorOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const { error } = body as { error?: unknown };
    if (typeof error === "string") return error;
  }
  return fallback;
}

// A 200 is not a promise that the body is an answer: a dev-server error page,
// a proxy interstitial or a truncated response all arrive as "ok". Casting
// straight to the result type would put a TypeError inside render, and a
// throw during render takes the whole client tree down — the panel would kill
// the dashboard it lives on.
function isAgentResponse(body: unknown): body is AgentResponse {
  if (typeof body !== "object" || body === null) return false;
  const { answer, citations, toolsUsed } = body as Record<string, unknown>;
  return typeof answer === "string" && Array.isArray(citations) && Array.isArray(toolsUsed);
}

function correlationOf(body: unknown): string | null {
  if (typeof body === "object" && body !== null) {
    const { correlation_id: id } = body as { correlation_id?: unknown };
    if (typeof id === "string") return id;
  }
  return null;
}

/**
 * The default transport: one POST with `Accept: text/event-stream`, SSE
 * events forwarded as they arrive, resolved with the `done` event's result.
 *
 * A refusal or a legacy non-streaming answer is still a JSON body with the
 * exact shapes the panel has always understood — the server decides whether
 * to stream, and this reader handles either wire format.
 */
async function ask(question: string, { signal, onStep, conversationId }: AskOptions): Promise<AgentResponse> {
  const response = await fetch("/api/agent/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({ question, conversation_id: conversationId }),
    signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    const body: unknown = await response.json().catch(() => null);

    if (response.status === 503) {
      throw new UnconfiguredError(errorOf(body, "the copilot is not configured"));
    }
    if (response.status === 429) {
      const seconds =
        typeof body === "object" && body !== null
          ? (body as { retry_after_seconds?: unknown }).retry_after_seconds
          : undefined;
      throw new RateLimitedError(
        errorOf(body, "the copilot is rate-limited right now"),
        typeof seconds === "number" ? seconds : null,
      );
    }
    if (!response.ok) {
      throw new TurnError(
        errorOf(body, `the request failed with status ${response.status}`),
        correlationOf(body),
      );
    }
    if (!isAgentResponse(body)) {
      throw new TurnError(
        "the copilot returned something that is not an answer",
        correlationOf(body),
      );
    }
    return body;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new TurnError("the copilot did not open a readable stream", null);

  const decoder = new TextDecoder();
  let buffer = "";
  let result: AgentResponse | null = null;

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      // The abort was ours (the Cancel button), so the turn was cancelled —
      // not an error. The server audits it; this panel just says so.
      if (signal.aborted) throw new TurnCancelledError();
      throw error;
    }
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data.length === 0) continue;

      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        continue; // a keep-alive or partial frame is not an event
      }
      if (typeof event !== "object" || event === null) continue;

      const kind = (event as { type?: unknown }).type;
      if (kind === "step" || kind === "tool_result" || kind === "tokens") {
        onStep(event as StreamStepEvent);
      } else if (kind === "done") {
        const candidate = (event as { result?: unknown }).result;
        if (isAgentResponse(candidate)) result = candidate;
      } else if (kind === "error") {
        const err = event as {
          error?: unknown;
          chain_exhausted?: unknown;
          retry_after_seconds?: unknown;
          correlation_id?: unknown;
        };
        if (err.chain_exhausted) {
          throw new RateLimitedError(
            typeof err.error === "string"
              ? err.error
              : "the copilot is rate-limited right now",
            typeof err.retry_after_seconds === "number" ? err.retry_after_seconds : null,
          );
        }
        throw new TurnError(
          typeof err.error === "string" ? err.error : "the copilot could not answer that",
          typeof err.correlation_id === "string" ? err.correlation_id : null,
        );
      }
    }
  }

  if (!result) {
    throw new TurnError("the copilot closed the stream without an answer", null);
  }
  return result;
}

/** One line of the running turn, rendered as it happens. */
interface StreamLine {
  id: number;
  text: string;
}

export function CopilotPanel({
  askQuestion = ask,
}: {
  /**
   * Injectable so stories and component tests can put the panel into each of
   * its states — idle, streaming, cancelled, answered, failed — without
   * stubbing the network. The default is the real route. A stub that only
   * takes the question still works: streaming is additive, and an answer
   * that arrives whole renders exactly as it did before spec 0013.
   */
  askQuestion?: AskQuestion;
}) {
  const { select } = useSelection();
  const [question, setQuestion] = useState("");
  const [citeNote, setCiteNote] = useState<string | null>(null);
  const [streamLines, setStreamLines] = useState<StreamLine[]>([]);
  const cancelRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const nextLineId = useRef(0);

  function pushLine(text: string) {
    nextLineId.current += 1;
    const id = nextLineId.current;
    setStreamLines((lines) => [...lines, { id, text }]);
  }

  const turn = useMutation({
    mutationFn: async (q: string) => {
      // One conversation per page session: the first question mints the id,
      // every follow-up names it, and the server re-fetches the history
      // itself (AC-03) — nothing is replayed from this client.
      if (!conversationIdRef.current) conversationIdRef.current = crypto.randomUUID();
      const controller = new AbortController();
      cancelRef.current = controller;
      setStreamLines([]);
      try {
        return await askQuestion(q, {
          signal: controller.signal,
          conversationId: conversationIdRef.current,
          onStep: (event) => {
            if (event.type === "step") {
              pushLine(`step ${event.stepNo + 1}: ${event.tool}`);
            } else if (event.type === "tool_result") {
              pushLine(`${event.tool} → ${event.summary}`);
            }
            // Token deltas keep the stream live; the steps are what a reader
            // needs, and the final answer renders from the done event.
          },
        });
      } finally {
        cancelRef.current = null;
      }
    },
    // A question that failed is not a question worth asking again unchanged:
    // every failure this surfaces is deterministic (no key, a rejected body,
    // a turn the agent could not complete).
    retry: false,
    onMutate: () => setCiteNote(null),
  });

  function cancelTurn() {
    cancelRef.current?.abort();
  }

  // A cited invoice opens the same drawer a metric tile opens, so "where did
  // this number come from" has one answer in this UI rather than two.
  async function openInvoice(externalId: string) {
    setCiteNote(null);
    const result = await fetchInvoiceLineage(createClient(), externalId);

    if (!result.ok) {
      setCiteNote(`Could not open ${externalId}: ${result.error}`);
      return;
    }
    if (result.data === null) {
      setCiteNote(
        `${externalId} is not an invoice you can see. A cited id that resolves to nothing is the answer to distrust.`,
      );
      return;
    }
    select({ label: `Invoice ${externalId}`, lineage: result.data });
  }

  const unconfigured = turn.error instanceof UnconfiguredError;
  const rateLimited = turn.error instanceof RateLimitedError;
  const cancelled = turn.error instanceof TurnCancelledError;

  const stepList = (testId: string) =>
    streamLines.length > 0 ? (
      <ul data-testid={testId} className="flex flex-col gap-tight">
        {streamLines.map((line) => (
          <li key={line.id} data-testid="copilot-step" className="text-xs text-muted-foreground">
            {line.text}
          </li>
        ))}
      </ul>
    ) : null;

  return (
    <Panel title="Copilot" testId="copilot">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = question.trim();
          if (trimmed.length > 0) turn.mutate(trimmed);
        }}
        className="flex flex-col gap-tight"
      >
        <label htmlFor="copilot-question" className="text-xs text-muted-foreground">
          Ask about this organisation&apos;s invoices and documents.
        </label>
        <Textarea
          id="copilot-question"
          data-testid="copilot-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Which invoices are overdue, and what are our payment terms?"
        />
        <Button
          type="submit"
          size="sm"
          data-testid="copilot-submit"
          disabled={turn.isPending || question.trim().length === 0}
          className="self-start"
        >
          {turn.isPending ? "Thinking…" : "Ask"}
        </Button>
      </form>

      <div className="mt-gutter" aria-live="polite">
        {turn.isIdle && (
          <EmptyState>
            Answers are built from rows your account can already see, and every
            claim carries the id it came from.
          </EmptyState>
        )}

        {turn.isPending && (
          <div data-testid="copilot-streaming" className="flex flex-col gap-tight">
            <p className="text-sm text-muted-foreground">
              Reading your invoices and documents…
            </p>
            {stepList("copilot-steps")}
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            {/* The one thing the reader can do about a running answer that
                turns out to have been a wrong question. The abort reaches
                the server, which audits the turn as cancelled (AC-02). */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="copilot-cancel"
              onClick={cancelTurn}
              className="self-start"
            >
              Cancel
            </Button>
          </div>
        )}

        {cancelled && (
          <div data-testid="copilot-cancelled" className="flex flex-col gap-tight">
            <p className="text-sm text-status-unknown">This answer was cancelled.</p>
            {stepList("copilot-steps")}
          </div>
        )}

        {unconfigured && (
          <p data-testid="copilot-unconfigured" className="text-sm text-muted-foreground">
            {turn.error?.message}. Everything else on this page is unaffected.
          </p>
        )}

        {rateLimited && (
          <p data-testid="copilot-rate-limited" className="text-sm text-status-warn">
            {turn.error?.message}
            {turn.error instanceof RateLimitedError && turn.error.retryAfterSeconds
              ? ` — try again in about ${humanize(turn.error.retryAfterSeconds)}.`
              : " — try again shortly."}
          </p>
        )}

        {turn.isError && !unconfigured && !rateLimited && !cancelled && (
          <div data-testid="copilot-error">
            {/* No reload button: the Ask button above stays enabled, and a
                reload would throw away the question still sitting in the
                textarea. The form is the retry. */}
            <PanelError message={turn.error.message} retry={false} />
            {turn.error instanceof TurnError && turn.error.correlationId && (
              <p className="mt-tight font-mono text-xs text-faint">
                correlation_id {turn.error.correlationId}
              </p>
            )}
          </div>
        )}

        {turn.isSuccess && <Answer result={turn.data} onOpenInvoice={openInvoice} />}

        {citeNote && (
          <p data-testid="copilot-cite-note" className="mt-tight text-xs text-status-warn">
            {citeNote}
          </p>
        )}
      </div>
    </Panel>
  );
}

function Answer({
  result,
  onOpenInvoice,
}: {
  result: AgentResponse;
  onOpenInvoice: (externalId: string) => void;
}) {
  const segments = segmentAnswer(result.answer, result.citations);
  // The server's verdict, not a second one computed here: the panel must not
  // be able to disagree with the check that ran against the tool results.
  const flagged = !result.verified;

  return (
    <div data-testid="copilot-answer" className="flex flex-col gap-tight">
      {result.demo === true && (
        <p
          data-testid="copilot-demo"
          className="rounded-control bg-status-unknown-surface px-snug py-tight text-xs text-status-unknown"
        >
          Demo answer — deterministic, from this tenant&apos;s real data, with no model
          call. Turn demo mode off in the admin panel for the live copilot.
        </p>
      )}

      {flagged && (
        <p
          role="alert"
          data-testid="copilot-unverified"
          className="rounded-control bg-status-warn-surface px-snug py-tight text-xs text-status-warn"
        >
          {result.uncited
            ? "This answer cites nothing, so none of it can be traced back to a row the copilot read. Check the figures against the panels on this page before using them."
            : "This answer cites something that was not in anything the copilot read. The citation is marked below and left where it is — treat the claim it supports as unverified."}
        </p>
      )}

      {result.outcome !== "ok" && (
        <p
          data-testid="copilot-outcome"
          className="rounded-control bg-status-unknown-surface px-snug py-tight text-xs text-status-unknown"
        >
          {result.outcome === "abstained"
            ? "The copilot found nothing relevant and stopped rather than composing an answer."
            : (result.terminationReason ?? `The turn ended early (${result.outcome}).`)}
        </p>
      )}

      <p className="whitespace-pre-wrap text-sm text-foreground">
        {segments.map((segment, index) =>
          segment.kind === "text" ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <CitationMarker
              key={index}
              citation={segment.citation}
              onOpenInvoice={onOpenInvoice}
            />
          ),
        )}
      </p>

      <p className="text-xs text-faint">
        {result.steps} {result.steps === 1 ? "step" : "steps"}
        {result.toolsUsed.length > 0 && ` · ${result.toolsUsed.join(", ")}`}
        {` · correlation_id ${result.correlation_id}`}
      </p>
    </div>
  );
}

function CitationMarker({
  citation,
  onOpenInvoice,
}: {
  citation: Citation;
  onOpenInvoice: (externalId: string) => void;
}) {
  const tone = citation.verified
    ? "bg-accent text-primary"
    : "bg-status-warn-surface text-status-warn";
  const label = `[${citation.kind}:${citation.id}]`;
  const title = citation.verified
    ? "This id was in a tool result for this question."
    : "This id was never in a tool result for this question.";

  // Only invoices have somewhere to go: a chunk is corpus text, and this
  // dashboard has no reader for it. A marker that led nowhere would be worse
  // than one that plainly does not claim to.
  if (citation.kind !== "invoice") {
    return (
      <span
        data-testid="copilot-citation"
        data-verified={citation.verified}
        title={title}
        className={`rounded-control font-mono text-xs ${tone}`}
      >
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="copilot-citation"
      data-verified={citation.verified}
      title={`${title} Opens its lineage.`}
      onClick={() => onOpenInvoice(citation.id)}
      className={`rounded-control font-mono text-xs underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${tone}`}
    >
      {label}
    </button>
  );
}
