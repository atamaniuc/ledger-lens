import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn } from "../loop";
import { ChainExhaustedError, createChain, createModelChain, parseChain, resolveChain, type ChainLink } from "./chain";
import { ModelError, type ModelClient } from "./types";
import type { Database } from "@/platform/supabase/database.types";

// ADR 0010, the failover chain, driven against stubbed clients: first
// provider succeeds; 429/5xx/timeout moves on; a 429 with a retry hint puts
// the provider into cooldown for exactly that window; every provider
// exhausted is one clear 429 naming the chain; and the provider that
// actually answered is the one recorded on the llm_calls rows.

const ok = (text = "Net 30 from the invoice date."): Anthropic.Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "stub",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }) as unknown as Anthropic.Message;

const rateLimited = (retryAfterMs?: number) => new ModelError("rate limit reached", 429, retryAfterMs);
const serverError = () => new ModelError("internal error", 503);
const timedOut = () => new ModelError("timed out", undefined, undefined, true);

interface Stub {
  link: ChainLink;
  calls: () => number;
}

/** A stub client whose behaviour can be queued per call. */
function stub(name: string, model: string, behaviours: (() => Promise<Anthropic.Message> | never)[]): Stub {
  let calls = 0;
  const client: ModelClient = {
    model,
    provider: name,
    createMessage: async () => {
      const behaviour = behaviours[Math.min(calls, behaviours.length - 1)];
      calls++;
      return behaviour();
    },
  };
  return { link: { name, model, client }, calls: () => calls };
}

const params = {
  model: "ignored",
  max_tokens: 4096,
  system: "You are a copilot.",
  messages: [{ role: "user", content: "what did we invoice?" }],
} as unknown as Anthropic.MessageCreateParamsNonStreaming;

function nowMachine() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("the failover chain (ADR 0010)", () => {
  it("uses the first provider when it answers", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [async () => ok()]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [async () => ok()]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    const step = await chain.createMessage(params, { timeoutMs: 5_000 });

    expect(step.provider).toBe("groq");
    expect(step.model).toBe("openai/gpt-oss-20b");
    expect(nvidia.calls()).toBe(0);
    expect(step.attempts).toEqual([
      { provider: "groq", model: "openai/gpt-oss-20b", outcome: "answered" },
    ]);
  });

  it("moves to the next provider on a 429", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [() => Promise.reject(rateLimited())]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [async () => ok()]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    const step = await chain.createMessage(params, { timeoutMs: 5_000 });

    expect(step.provider).toBe("nvidia");
    expect(step.model).toBe("meta/llama-3.3-70b-instruct");
    expect(groq.calls()).toBe(1);
    expect(step.attempts).toMatchObject([
      { provider: "groq", outcome: "error", status: 429 },
      { provider: "nvidia", outcome: "answered" },
    ]);
  });

  it("moves on for a 5xx and for a timeout too", async () => {
    const failing = stub("groq", "openai/gpt-oss-20b", [
      () => Promise.reject(serverError()),
      () => Promise.reject(timedOut()),
    ]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [
      async () => ok(),
      async () => ok(),
    ]);
    const chain = createChain([failing.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    const first = await chain.createMessage(params, { timeoutMs: 5_000 });
    expect(first.provider).toBe("nvidia");

    const second = await chain.createMessage(params, { timeoutMs: 5_000 });
    expect(second.provider).toBe("nvidia");
    expect(second.attempts[0]).toMatchObject({ provider: "groq", outcome: "error", status: undefined });
    expect(failing.calls()).toBe(2);
  });

  it("does not fail over on a 400 — that is a config or request bug, not provider trouble", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [() => Promise.reject(new ModelError("bad request", 400))]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [async () => ok()]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    await expect(chain.createMessage(params, { timeoutMs: 5_000 })).rejects.toThrow(/bad request/);
    expect(nvidia.calls()).toBe(0);
  });

  it("puts a provider with a retry hint into cooldown and skips it until it expires", async () => {
    const clock = nowMachine();
    // First call 429s with a 10s hint; once the cooldown expires groq must
    // be tried again — and this time it answers.
    const groq = stub("groq", "openai/gpt-oss-20b", [
      () => Promise.reject(rateLimited(10_000)),
      async () => ok(),
    ]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [
      async () => ok(),
      async () => ok(),
    ]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: clock.now });

    // First call: groq 429s with a 10s hint and goes into cooldown.
    const first = await chain.createMessage(params, { timeoutMs: 5_000 });
    expect(first.provider).toBe("nvidia");

    // Second call, inside the window: groq is skipped, not called again.
    clock.advance(5_000);
    const second = await chain.createMessage(params, { timeoutMs: 5_000 });
    expect(second.provider).toBe("nvidia");
    expect(second.attempts[0]).toMatchObject({ provider: "groq", outcome: "skipped" });
    expect(groq.calls()).toBe(1);

    // After the window expires the preferred provider is tried again.
    clock.advance(6_000);
    const third = await chain.createMessage(params, { timeoutMs: 5_000 });
    expect(third.provider).toBe("groq");
    expect(groq.calls()).toBe(2);
  });

  it("every provider exhausted is one clear 429 naming the chain", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [() => Promise.reject(rateLimited(30_000))]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [() => Promise.reject(new ModelError("no quota", 429))]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    await expect(chain.createMessage(params, { timeoutMs: 5_000 })).rejects.toMatchObject({
      name: "ChainExhaustedError",
      status: 429,
    });
    await expect(chain.createMessage(params, { timeoutMs: 5_000 })).rejects.toThrow(/groq/);
    await expect(chain.createMessage(params, { timeoutMs: 5_000 })).rejects.toThrow(/nvidia/);
    await expect(chain.createMessage(params, { timeoutMs: 5_000 })).rejects.toThrow(/failover chain/);
  });

  it("an exhausted chain with only 5xx answers still reports the chain, as a 429", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [() => Promise.reject(serverError())]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [() => Promise.reject(serverError())]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    const error = await chain
      .createMessage(params, { timeoutMs: 5_000 })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ChainExhaustedError);
    expect((error as ChainExhaustedError).status).toBe(429);
    expect((error as ChainExhaustedError).message).toContain("groq, nvidia");
    expect((error as ChainExhaustedError).attempts).toHaveLength(2);
  });
});

describe("resolution (ADR 0010)", () => {
  const VARS = [
    "LLM_CHAIN",
    "LLM_PROVIDER",
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "GROQ_API_KEY",
    "GROQ_MODEL",
    "NVIDIA_API_KEY",
    "NVIDIA_MODEL",
  ];
  const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));

  function only(env: Record<string, string>) {
    for (const name of VARS) delete process.env[name];
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
  }

  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("a malformed chain value fails loudly", () => {
    only({ LLM_CHAIN: "groq,bogus" });
    expect(() => parseChain(process.env.LLM_CHAIN)).toThrow(/bogus/);
    expect(() => parseChain(process.env.LLM_CHAIN)).toThrow(/known providers are/);
    expect(() => resolveChain()).toThrow(ModelError);
    // And the route-facing constructor fails the same way.
    expect(() => createModelChain()).toThrow(/LLM_CHAIN names "bogus"/);
  });

  it("rejects a provider listed twice — one key per provider, per ADR 0010", () => {
    only({ LLM_CHAIN: "groq,nvidia,groq" });
    expect(() => resolveChain()).toThrow(/twice/);
  });

  it("rejects a chain entry whose key is missing, instead of silently shortening the chain", () => {
    only({ LLM_CHAIN: "groq,nvidia", GROQ_API_KEY: "g" });
    expect(() => resolveChain()).toThrow(/NVIDIA_API_KEY/);
  });

  it("resolves an ordered chain from LLM_CHAIN, head first", () => {
    only({ LLM_CHAIN: "nvidia,groq", GROQ_API_KEY: "g", NVIDIA_API_KEY: "n" });
    const chain = resolveChain();
    expect(chain?.map((entry) => entry.spec.name)).toEqual(["nvidia", "groq"]);
    expect(chain?.[0].model).toBe("meta/llama-3.3-70b-instruct");
  });

  it("without LLM_CHAIN keeps the single-provider behaviour", () => {
    only({ GROQ_API_KEY: "g" });
    const chain = resolveChain();
    expect(chain?.map((entry) => entry.spec.name)).toEqual(["groq"]);
  });

  it("returns null when nothing is configured", () => {
    only({});
    expect(resolveChain()).toBeNull();
    expect(createModelChain()).toBeNull();
  });
});

describe("the recorded provider is the one that answered (ADR 0010)", () => {
  it("stamps the answering provider and the chain head onto every llm_calls row", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [() => Promise.reject(rateLimited())]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [async () => ok()]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return { data: rpcs.length, error: null };
      },
      from: () => {
        throw new Error("no tool should run in this test");
      },
    } as unknown as SupabaseClient<Database>;

    const result = await runAgentTurn({
      question: "what are our payment terms?",
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId: "corr-chain",
      supabase,
      chain,
    });

    // The turn was answered by nvidia after groq 429'd — and the row says so.
    const calls = rpcs.filter((r) => r.fn === "log_llm_call");
    const last = calls.at(-1);
    expect(last?.args.p_provider).toBe("nvidia");
    expect(last?.args.p_model).toBe("meta/llama-3.3-70b-instruct");
    expect(last?.args.p_preferred_provider).toBe("groq");

    // The result surfaces the same facts for the API response.
    expect(result.provider).toBe("nvidia");
    expect(result.model).toBe("meta/llama-3.3-70b-instruct");
    expect(result.fallback).toBe(true);
    expect(result.chainAttempts?.[0]).toMatchObject({ provider: "groq", outcome: "error" });
  });

  it("reports fallback=false when the preferred provider answers every step", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [async () => ok()]);
    const chain = createChain([groq.link], { cooldown: new Map(), now: () => 0 });

    const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return { data: rpcs.length, error: null };
      },
      from: () => {
        throw new Error("no tool should run in this test");
      },
    } as unknown as SupabaseClient<Database>;

    const result = await runAgentTurn({
      question: "what are our payment terms?",
      orgId: "00000000-0000-4000-8000-000000000001",
      correlationId: "corr-chain-ok",
      supabase,
      chain,
    });

    expect(result.provider).toBe("groq");
    expect(result.fallback).toBe(false);
    const calls = rpcs.filter((r) => r.fn === "log_llm_call");
    expect(calls.at(-1)?.args.p_provider).toBe("groq");
    expect(calls.at(-1)?.args.p_preferred_provider).toBe("groq");
  });

  it("an exhausted chain still audits the step as outcome error before the 429 leaves the loop", async () => {
    const groq = stub("groq", "openai/gpt-oss-20b", [() => Promise.reject(rateLimited())]);
    const nvidia = stub("nvidia", "meta/llama-3.3-70b-instruct", [() => Promise.reject(new ModelError("no quota", 429))]);
    const chain = createChain([groq.link, nvidia.link], { cooldown: new Map(), now: () => 0 });

    const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
    const supabase = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return { data: rpcs.length, error: null };
      },
      from: () => {
        throw new Error("no tool should run in this test");
      },
    } as unknown as SupabaseClient<Database>;

    await expect(
      runAgentTurn({
        question: "what are our payment terms?",
        orgId: "00000000-0000-4000-8000-000000000001",
        correlationId: "corr-chain-exhausted",
        supabase,
        chain,
      }),
    ).rejects.toBeInstanceOf(ChainExhaustedError);

    const calls = rpcs.filter((r) => r.fn === "log_llm_call");
    const last = calls.at(-1);
    expect(last?.args.p_outcome).toBe("error");
    expect(last?.args.p_preferred_provider).toBe("groq");
    // The attempts are queryable from the row, not just the API body.
    expect(Array.isArray(last?.args.p_tool_args)).toBe(true);
    expect((last?.args.p_tool_args as { provider: string }[]).map((a) => a.provider)).toEqual([
      "groq",
      "nvidia",
    ]);
  });
});
