"""Environment resolution and the judge-must-differ-from-answerer guard.

The answering model's (provider, model) pair mirrors
src/features/agent/providers/index.ts: LLM_PROVIDER names one explicitly,
otherwise the first configured key wins. The judge takes its own keys
(JUDGE_*) so a run can point the judge at a different provider than the
answerer (decisions/0010, spec 0008: the judge must use a DIFFERENT
provider/model than the one that produced the answer, and every provider it
uses must have a free tier).

These keys are read defensively here (the TS zod schema in
src/platform/config.ts is owned elsewhere); new keys to add there:
JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_API_KEY, JUDGE_BASE_URL.
"""

from __future__ import annotations

from dataclasses import dataclass

# anthropic is deliberately absent: it has no free tier and no
# OpenAI-compatible chat endpoint, so the judge cannot be zero-cost on it.
FREE_TIER_PROVIDERS = frozenset({"groq", "nvidia", "openai-compatible"})

# provider -> default OpenAI-compatible base URL (judge only; the free-tier set)
_JUDGE_BASE_URLS: dict[str, str] = {
    "groq": "https://api.groq.com/openai/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "openai-compatible": "",
}

_ANSWERER_MODEL_VARS: dict[str, str] = {
    "anthropic": "ANTHROPIC_MODEL",
    "groq": "GROQ_MODEL",
    "nvidia": "NVIDIA_MODEL",
    "openai-compatible": "LLM_MODEL",
}

_ANSWERER_KEY_VARS: dict[str, str] = {
    "anthropic": "ANTHROPIC_API_KEY",
    "groq": "GROQ_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "openai-compatible": "LLM_API_KEY",
}


class JudgeConfigError(RuntimeError):
    """The judge or answerer environment is misconfigured."""


@dataclass(frozen=True)
class ModelSpec:
    provider: str
    model: str
    api_key: str | None = None
    base_url: str | None = None


def resolve_answerer(env: dict[str, str]) -> ModelSpec | None:
    """The answering model, mirroring the TS resolution (LLM_PROVIDER or first configured key)."""
    provider = (env.get("LLM_PROVIDER") or "").strip().lower()
    if provider:
        if provider not in _ANSWERER_MODEL_VARS:
            known = ", ".join(sorted(_ANSWERER_MODEL_VARS))
            raise JudgeConfigError(f'LLM_PROVIDER is "{provider}"; known providers are {known}')
        return ModelSpec(
            provider=provider,
            model=(env.get(_ANSWERER_MODEL_VARS[provider]) or "").strip(),
            api_key=env.get(_ANSWERER_KEY_VARS[provider]) or None,
            base_url=(env.get("LLM_BASE_URL") or None) if provider == "openai-compatible" else None,
        )
    for provider, model_var in _ANSWERER_MODEL_VARS.items():
        if env.get(_ANSWERER_KEY_VARS[provider]):
            return ModelSpec(
                provider=provider,
                model=(env.get(model_var) or "").strip(),
                api_key=env.get(_ANSWERER_KEY_VARS[provider]),
                base_url=(env.get("LLM_BASE_URL") or None)
                if provider == "openai-compatible"
                else None,
            )
    return None


def resolve_judge(env: dict[str, str], *, default_provider: str = "groq") -> ModelSpec:
    """The judge model. Never silently defaults to anything that costs money."""
    provider = (env.get("JUDGE_PROVIDER") or default_provider).strip().lower()
    if provider not in FREE_TIER_PROVIDERS:
        free = ", ".join(sorted(FREE_TIER_PROVIDERS))
        raise JudgeConfigError(
            f"JUDGE_PROVIDER is {provider!r}; the judge may only use a free-tier "
            f"provider ({free}) — anthropic has no free tier"
        )
    model = (env.get("JUDGE_MODEL") or "").strip()
    if not model:
        raise JudgeConfigError("JUDGE_MODEL is not set — the judge needs a model name")
    api_key = (env.get("JUDGE_API_KEY") or "").strip()
    base_url = (env.get("JUDGE_BASE_URL") or "").strip() or _JUDGE_BASE_URLS[provider] or None
    if provider == "openai-compatible" and not base_url:
        raise JudgeConfigError(
            "JUDGE_BASE_URL is not set (required for JUDGE_PROVIDER=openai-compatible)"
        )
    return ModelSpec(
        provider=provider,
        model=model,
        api_key=api_key or None,
        base_url=base_url or None,
    )


def assert_judge_differs(judge: ModelSpec, answerer: ModelSpec | None) -> str | None:
    """Raise when the judge would grade itself; warn when it shares a provider."""
    if answerer is None:
        raise JudgeConfigError(
            "cannot verify the judge differs from the answerer: no answering model is "
            "configured (set LLM_PROVIDER/LLM_MODEL or pass --answerer-provider/--answerer-model)"
        )
    if not answerer.model:
        raise JudgeConfigError(
            "the answering model's name is not configured — cannot compare it with the judge"
        )
    if judge.model.lower() == answerer.model.lower():
        raise JudgeConfigError(
            f"the judge model {judge.model!r} would judge itself: the answerer ran on the "
            "same model. Point JUDGE_MODEL (or JUDGE_PROVIDER) at a different free-tier model."
        )
    if judge.provider == answerer.provider:
        return (
            f"judge and answerer share provider {judge.provider!r} "
            f"(judge {judge.model!r} vs answer {answerer.model!r}); a same-provider judge "
            "is a weaker signal than a cross-provider one"
        )
    return None
