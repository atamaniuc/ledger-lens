import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  DatabaseZap,
  FileSearch,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { createClient } from "@/platform/supabase/server-client";

// The landing page. It exists for one reader: someone evaluating this project
// who has not signed in and will not run it locally.
//
// It says what the system does and what makes the claim checkable, and it
// does not restate PROGRESS.md — the honest limitations live there and in the
// README's TODO, and duplicating them here would create two versions to keep
// in sync. A signed-in visitor is sent straight to the product.

const PILLARS = [
  {
    icon: DatabaseZap,
    title: "Validated ingestion",
    body: "Idempotent, cursor-based ingestion against a provider that fails on purpose — duplicates, schema drift, 429s, 500s, expired tokens. Every failure mode stays as a regression test.",
  },
  {
    icon: ScrollText,
    title: "Reconciliation you can audit",
    body: "Four quality checks per run, compared against the provider's own independent total rather than against itself. Drift is a measured number, not an assurance.",
  },
  {
    icon: FileSearch,
    title: "Answers that cite their rows",
    body: "Hybrid vector and full-text retrieval fused by RRF. Every cited id is checked against what the agent actually retrieved; anything else is shown and marked unverified.",
  },
  {
    icon: ShieldCheck,
    title: "Safety by capability",
    body: "Four read-only tools, no send capability, the user's own JWT. A poisoned document can instruct the agent to exfiltrate data — there is simply no tool that could, and the attempt is logged.",
  },
];

const FACTS = [
  { value: "0%", label: "reconciliation drift, measured" },
  { value: "1.00", label: "recall@5 on the eval set" },
  { value: "4", label: "agent tools, none with side effects" },
  { value: "0", label: "unaudited agent actions" },
];

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Signed in, the dashboard is the product; there is nothing here they need.
  if (user) redirect("/dashboard");

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-section p-page">
      <section className="flex flex-col items-start gap-gutter pt-page">
        <Badge variant="secondary">Portfolio project</Badge>
        <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
          An AI copilot over financial data you can actually trust.
        </h1>
        <p className="max-w-2xl text-base text-pretty text-muted-foreground">
          An LLM on top of unvalidated data does not fix bad data — it makes
          wrong numbers sound more convincing. LedgerLens builds the pipeline
          first: ingestion that survives a hostile provider, reconciliation
          against an independent total, and only then an agent that can answer
          from it.
        </p>
        <div className="flex flex-wrap items-center gap-tight">
          <Button asChild size="lg">
            <Link href="/login">
              Sign in to the dashboard
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a
              href="https://github.com/atamaniuc/ledger-lens/blob/main/docs/ARCHITECTURE.md"
              target="_blank"
              rel="noreferrer noopener"
            >
              Read the architecture
            </a>
          </Button>
        </div>
      </section>

      <Separator />

      <section
        aria-label="Measured results"
        className="grid grid-cols-2 gap-gutter sm:grid-cols-4"
      >
        {FACTS.map((fact) => (
          <div key={fact.label} className="flex flex-col gap-1">
            <span className="font-mono text-2xl font-semibold text-foreground">
              {fact.value}
            </span>
            <span className="text-xs text-muted-foreground">{fact.label}</span>
          </div>
        ))}
      </section>

      <section className="grid gap-gutter sm:grid-cols-2">
        {PILLARS.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <CardHeader>
              <Icon className="size-5 text-primary" aria-hidden />
              <CardTitle>{title}</CardTitle>
              <CardDescription className="text-pretty">{body}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>What is deliberately not built</CardTitle>
          <CardDescription>
            The gaps are written down rather than left to be discovered. The
            README carries the full list — no live model run in the development
            environment, a manual index rebuild, a single-turn agent, and an
            eval set that is a floor rather than a measurement.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Every stage records what it cost and which defect it caught, including
          the ones found late: a chunker that silently dropped text, an
          abstention mechanism that could never fire, and a citation warning
          that fired on correct answers.
        </CardContent>
      </Card>
    </main>
  );
}
