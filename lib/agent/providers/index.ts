import Anthropic from "@anthropic-ai/sdk";
import { openAiCompatibleClient } from "./openai-compatible";
import { ModelError, type ModelClient, type ModelRequestOptions } from "./types";

// Which model the copilot runs on, and where it comes from.
//
// The agent's safety story does not depend on the vendor. RLS scopes what a
// tool can read, the registry bounds what a tool can do, citations are checked
// against what a tool actually returned, and none of that is the model's to
// decide (ADR 0009). So swapping the provider is a configuration change, and
// the free OpenAI-compatible tiers are here because "the copilot is not
// configured on this deployment" is a bad answer when a working one costs an
// environment variable.
//
// Quality is a different question from safety, and it is not claimed to be
// equal across providers. Stage 6's eval set is what measures that: point
// `LLM_PROVIDER` at a provider and run `task evals`.

export type { ModelClient, ModelRequestOptions };
export { ModelError };

interface ProviderSpec {
  name: string;
  keyVar: string;
  baseUrl?: string;
  defaultModel: string;
  modelVar: string;
}

/**
 * Order matters: with nothing set explicitly, the first configured provider
 * in this list wins. Anthropic is first because it is what the prompt and the
 * eval baseline were written against; the free tiers follow.
 */
const PROVIDERS: ProviderSpec[] = [
  {
    name: "anthropic",
    keyVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-opus-5",
    modelVar: "ANTHROPIC_MODEL",
  },
  {
    name: "groq",
    keyVar: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    // Tool calling is not optional here — an agent whose model cannot call a
    // function has no way to reach any data. Both defaults below support it.
    defaultModel: "llama-3.3-70b-versatile",
    modelVar: "GROQ_MODEL",
  },
  {
    name: "nvidia",
    keyVar: "NVIDIA_API_KEY",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct",
    modelVar: "NVIDIA_MODEL",
  },
  {
    // Anything else that speaks chat-completions: Together, OpenRouter, a
    // local vLLM or Ollama. Needs its own base URL, so it is never selected
    // by accident.
    name: "openai-compatible",
    keyVar: "LLM_API_KEY",
    defaultModel: "",
    modelVar: "LLM_MODEL",
  },
];

export interface ResolvedProvider {
  spec: ProviderSpec;
  apiKey: string;
  baseUrl: string;
  model: string;
}

function configured(spec: ProviderSpec): ResolvedProvider | null {
  const apiKey = process.env[spec.keyVar];
  if (!apiKey) return null;

  const baseUrl = spec.baseUrl ?? process.env.LLM_BASE_URL ?? "";
  const model = process.env[spec.modelVar] ?? spec.defaultModel;

  // A provider named but not fully described is a configuration mistake, not
  // a reason to fall through to a different one silently.
  if (spec.name !== "anthropic" && baseUrl.length === 0) return null;
  if (model.length === 0) return null;

  return { spec, apiKey, baseUrl, model };
}

/**
 * The provider this deployment will use, or `null` when none is configured.
 * `LLM_PROVIDER` names one explicitly; otherwise the first configured wins.
 */
export function resolveProvider(): ResolvedProvider | null {
  const requested = process.env.LLM_PROVIDER?.trim().toLowerCase();

  if (requested) {
    const spec = PROVIDERS.find((candidate) => candidate.name === requested);
    if (!spec) {
      throw new ModelError(
        `LLM_PROVIDER is "${requested}"; known providers are ${PROVIDERS.map((p) => p.name).join(", ")}`,
      );
    }
    // Named explicitly and unusable is an error rather than a fallback: a
    // deployment that asked for Groq and quietly got something else is worse
    // than one that says the key is missing.
    const resolved = configured(spec);
    if (!resolved) {
      throw new ModelError(
        `LLM_PROVIDER is "${requested}" but ${spec.keyVar}${
          spec.baseUrl ? "" : " and LLM_BASE_URL"
        } are not set`,
      );
    }
    return resolved;
  }

  for (const spec of PROVIDERS) {
    const resolved = configured(spec);
    if (resolved) return resolved;
  }
  return null;
}

/** A one-line description for logs and for the route's 503 message. */
export function providerSummary(): string {
  const resolved = resolveProvider();
  if (!resolved) {
    return `no model provider is configured — set one of ${PROVIDERS.map((p) => p.keyVar).join(", ")}`;
  }
  return `${resolved.spec.name}/${resolved.model}`;
}

export function createModelClient(): ModelClient | null {
  const resolved = resolveProvider();
  if (!resolved) return null;

  if (resolved.spec.name === "anthropic") {
    const anthropic = new Anthropic({ apiKey: resolved.apiKey });
    return {
      model: resolved.model,
      provider: "anthropic",
      createMessage: (params, options) =>
        anthropic.messages.create(params, { timeout: options.timeoutMs }),
    };
  }

  return openAiCompatibleClient({
    provider: resolved.spec.name,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    model: resolved.model,
  });
}
