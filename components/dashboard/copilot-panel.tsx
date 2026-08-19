"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { segmentAnswer, type Citation } from "@/lib/agent/citations";
import type { AgentTurnResult } from "@/lib/agent/loop";
import { fetchInvoiceLineage } from "@/lib/dashboard/queries";
import { createClient } from "@/lib/supabase/browser-client";
import { EmptyState, Panel, PanelError } from "@/components/ui/status-badge";
import { useSelection } from "./selection-context";

// US-07. The copilot: ask a question, get an answer built from this org's own
// rows, with every claim traceable back to what the agent actually read.
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

type AgentResponse = AgentTurnResult & { correlation_id: string };

/**
 * An operator problem, not the reader's. Carried as its own error type so the
 * panel does not render "the copilot failed to answer your question" over a
 * deployment that was never given a key.
 */
class UnconfiguredError extends Error {}

class TurnError extends Error {
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
class RateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

async function ask(question: string): Promise<AgentResponse> {
  const response = await fetch("/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
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

export function CopilotPanel() {
  const { select } = useSelection();
  const [question, setQuestion] = useState("");
  const [citeNote, setCiteNote] = useState<string | null>(null);

  const turn = useMutation({
    mutationFn: ask,
    // A question that failed is not a question worth asking again unchanged:
    // every failure this surfaces is deterministic (no key, a rejected body,
    // a turn the agent could not complete).
    retry: false,
    onMutate: () => setCiteNote(null),
  });

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

      <div className="mt-gutter">
        {turn.isIdle && (
          <EmptyState>
            Answers are built from rows your account can already see, and every
            claim carries the id it came from.
          </EmptyState>
        )}

        {turn.isPending && (
          <div data-testid="copilot-loading" className="flex flex-col gap-tight">
            <p className="text-sm text-muted-foreground">
              Reading your invoices and documents…
            </p>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
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
              ? ` — try again in about ${turn.error.retryAfterSeconds} seconds.`
              : " — try again shortly."}
          </p>
        )}

        {turn.isError && !unconfigured && !rateLimited && (
          <div data-testid="copilot-error">
            <PanelError message={turn.error.message} />
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
      {flagged && (
        <p
          role="alert"
          data-testid="copilot-unverified"
          className="rounded-control bg-status-warn-surface px-snug py-tight text-xs text-status-warn"
        >
          This answer cites something that was not in anything the copilot read.
          The citation is marked below and left where it is — treat the claim it
          supports as unverified.
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
      className={`rounded-control font-mono text-xs underline ${tone}`}
    >
      {label}
    </button>
  );
}
