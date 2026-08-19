import { afterEach, describe, expect, it } from "bun:test";
import { ModelError, providerSummary, resolveProvider } from "./index";

// Which provider a deployment ends up on, asserted rather than assumed. The
// failure this guards against is silent: a deployment that asked for one
// provider and quietly ran on another would still answer questions, and the
// only trace would be the model name on `llm_calls` rows nobody reads.

const VARS = [
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

describe("resolveProvider", () => {
  it("returns null when nothing is configured", () => {
    only({});
    expect(resolveProvider()).toBeNull();
    expect(providerSummary()).toContain("no model provider is configured");
  });

  it("prefers Anthropic when several are configured and none is named", () => {
    only({ ANTHROPIC_API_KEY: "a", GROQ_API_KEY: "g" });
    expect(resolveProvider()?.spec.name).toBe("anthropic");
  });

  it("falls through to a free tier when Anthropic is absent", () => {
    only({ GROQ_API_KEY: "g" });
    const resolved = resolveProvider();
    expect(resolved?.spec.name).toBe("groq");
    expect(resolved?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(resolved?.model).toBe("openai/gpt-oss-20b");
  });

  it("honours an explicit LLM_PROVIDER over the order", () => {
    only({ ANTHROPIC_API_KEY: "a", NVIDIA_API_KEY: "n", LLM_PROVIDER: "nvidia" });
    expect(resolveProvider()?.spec.name).toBe("nvidia");
  });

  it("fails rather than falling back when the named provider has no key", () => {
    // The important one. Falling back here would mean a deployment that asked
    // for Groq answered on Anthropic and was billed for it.
    only({ ANTHROPIC_API_KEY: "a", LLM_PROVIDER: "groq" });
    expect(() => resolveProvider()).toThrow(ModelError);
    expect(() => resolveProvider()).toThrow(/GROQ_API_KEY/);
  });

  it("rejects a provider name it does not know", () => {
    only({ LLM_PROVIDER: "gpt5-turbo-max" });
    expect(() => resolveProvider()).toThrow(/known providers are/);
  });

  it("lets a model be overridden per provider", () => {
    only({ GROQ_API_KEY: "g", GROQ_MODEL: "moonshotai/kimi-k2-instruct" });
    expect(resolveProvider()?.model).toBe("moonshotai/kimi-k2-instruct");
  });

  it("will not select a generic endpoint without a base URL", () => {
    // `openai-compatible` has no built-in host, so a key alone is not enough
    // to describe it — selecting it would produce requests to "/chat/completions".
    only({ LLM_API_KEY: "k", LLM_MODEL: "qwen3" });
    expect(resolveProvider()).toBeNull();

    only({ LLM_API_KEY: "k", LLM_MODEL: "qwen3", LLM_BASE_URL: "http://localhost:11434/v1" });
    expect(resolveProvider()?.spec.name).toBe("openai-compatible");
  });

  it("summarises the choice as provider/model", () => {
    only({ GROQ_API_KEY: "g" });
    expect(providerSummary()).toBe("groq/openai/gpt-oss-20b");
  });
});
