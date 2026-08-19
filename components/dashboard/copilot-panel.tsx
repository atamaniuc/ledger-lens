"use client";

import { useState } from "react";
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
// State is a `useState` machine and a `fetch`, matching `LineageDrillDown`.
// One request, no cache to share and nothing to refetch, so a query client
// would be machinery around a single POST.

type AgentResponse = AgentTurnResult & { correlation_id: string };

type State =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "answered"; result: AgentResponse }
  // An operator problem, not the reader's: it gets its own state so it does
  // not read as "the copilot failed to answer your question".
  | { kind: "unconfigured"; message: string }
  | { kind: "failed"; message: string; correlationId: string | null };

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

export function CopilotPanel() {
  const { select } = useSelection();
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [citeNote, setCiteNote] = useState<string | null>(null);

  async function ask(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length === 0 || state.kind === "asking") return;

    setState({ kind: "asking" });
    setCiteNote(null);

    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const body: unknown = await response.json().catch(() => null);

      if (response.status === 503) {
        setState({ kind: "unconfigured", message: errorOf(body, "the copilot is not configured") });
        return;
      }
      if (!response.ok) {
        setState({
          kind: "failed",
          message: errorOf(body, `the request failed with status ${response.status}`),
          correlationId: correlationOf(body),
        });
        return;
      }

      if (!isAgentResponse(body)) {
        setState({
          kind: "failed",
          message: "the copilot returned something that is not an answer",
          correlationId: correlationOf(body),
        });
        return;
      }
      setState({ kind: "answered", result: body });
    } catch (error) {
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
        correlationId: null,
      });
    }
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

  return (
    <Panel title="Copilot" testId="copilot">
      <form onSubmit={ask} className="flex flex-col gap-tight">
        <label htmlFor="copilot-question" className="text-xs text-muted">
          Ask about this organisation&apos;s invoices and documents.
        </label>
        <textarea
          id="copilot-question"
          data-testid="copilot-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="Which invoices are overdue, and what are our payment terms?"
          className="w-full resize-y rounded-control border border-border-subtle bg-surface-sunken p-tight text-sm text-foreground placeholder:text-faint"
        />
        <button
          type="submit"
          data-testid="copilot-submit"
          disabled={state.kind === "asking" || question.trim().length === 0}
          className="self-start rounded-control bg-accent-surface px-snug py-tight text-xs font-medium text-accent disabled:opacity-50"
        >
          {state.kind === "asking" ? "Thinking…" : "Ask"}
        </button>
      </form>

      <div className="mt-gutter">
        {state.kind === "idle" && (
          <EmptyState>
            Answers are built from rows your account can already see, and every
            claim carries the id it came from.
          </EmptyState>
        )}

        {state.kind === "asking" && (
          <p data-testid="copilot-loading" className="text-sm text-muted">
            Reading your invoices and documents…
          </p>
        )}

        {state.kind === "unconfigured" && (
          <p data-testid="copilot-unconfigured" className="text-sm text-muted">
            {state.message}. Everything else on this page is unaffected.
          </p>
        )}

        {state.kind === "failed" && (
          <div data-testid="copilot-error">
            <PanelError message={state.message} />
            {state.correlationId && (
              <p className="mt-tight font-mono text-xs text-faint">
                correlation_id {state.correlationId}
              </p>
            )}
          </div>
        )}

        {state.kind === "answered" && (
          <Answer result={state.result} onOpenInvoice={openInvoice} />
        )}

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
    ? "bg-accent-surface text-accent"
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
