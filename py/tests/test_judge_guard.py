"""The judge-must-differ-from-answerer guard and env resolution (decisions/0010)."""

from __future__ import annotations

import pytest

from ledgerlens_judge.config import (
    JudgeConfigError,
    ModelSpec,
    assert_judge_differs,
    resolve_answerer,
    resolve_judge,
)


def test_judge_equal_to_answerer_raises() -> None:
    judge = ModelSpec(provider="groq", model="gpt-oss-20b")
    answerer = ModelSpec(provider="groq", model="gpt-oss-20b")
    with pytest.raises(JudgeConfigError, match="judge itself"):
        assert_judge_differs(judge, answerer)


def test_judge_same_model_different_provider_raises() -> None:
    # Same model under another provider is still self-grading.
    judge = ModelSpec(provider="nvidia", model="gpt-oss-20b")
    answerer = ModelSpec(provider="groq", model="gpt-oss-20b")
    with pytest.raises(JudgeConfigError, match="judge itself"):
        assert_judge_differs(judge, answerer)


def test_same_provider_different_model_warns_not_fails() -> None:
    judge = ModelSpec(provider="groq", model="llama-3.3-70b-versatile")
    answerer = ModelSpec(provider="groq", model="gpt-oss-20b")
    warning = assert_judge_differs(judge, answerer)
    assert warning is not None
    assert "same-provider judge" in warning


def test_cross_provider_judge_is_clean() -> None:
    judge = ModelSpec(provider="nvidia", model="llama-3.3-70b")
    answerer = ModelSpec(provider="groq", model="gpt-oss-20b")
    assert assert_judge_differs(judge, answerer) is None


def test_guard_without_answerer_raises() -> None:
    with pytest.raises(JudgeConfigError, match="cannot verify"):
        assert_judge_differs(ModelSpec(provider="groq", model="llama-3.3-70b-versatile"), None)


def test_guard_with_unnamed_answerer_raises() -> None:
    with pytest.raises(JudgeConfigError, match="answering model's name"):
        assert_judge_differs(
            ModelSpec(provider="groq", model="x"), ModelSpec(provider="groq", model="")
        )


def test_anthropic_judge_is_rejected() -> None:
    # No free tier, no OpenAI-compatible endpoint — the judge cannot be zero-cost on it.
    with pytest.raises(JudgeConfigError, match="free-tier"):
        resolve_judge({"JUDGE_PROVIDER": "anthropic", "JUDGE_MODEL": "claude-3-5-sonnet"})


def test_judge_requires_a_model_name() -> None:
    with pytest.raises(JudgeConfigError, match="JUDGE_MODEL"):
        resolve_judge({"JUDGE_PROVIDER": "groq"})


def test_judge_defaults_to_groq() -> None:
    spec = resolve_judge({"JUDGE_MODEL": "llama-3.3-70b-versatile", "JUDGE_API_KEY": "k"})
    assert spec.provider == "groq"
    assert spec.base_url == "https://api.groq.com/openai/v1"


def test_openai_compatible_judge_needs_base_url() -> None:
    with pytest.raises(JudgeConfigError, match="JUDGE_BASE_URL"):
        resolve_judge({"JUDGE_PROVIDER": "openai-compatible", "JUDGE_MODEL": "m"})


def test_unknown_judge_provider_is_rejected() -> None:
    with pytest.raises(JudgeConfigError, match="free-tier"):
        resolve_judge({"JUDGE_PROVIDER": "somebody", "JUDGE_MODEL": "m"})


def test_resolve_answerer_explicit_provider() -> None:
    spec = resolve_answerer({"LLM_PROVIDER": "groq", "GROQ_MODEL": "gpt-oss-20b"})
    assert spec is not None
    assert spec.provider == "groq"
    assert spec.model == "gpt-oss-20b"


def test_resolve_answerer_first_configured_key_wins() -> None:
    spec = resolve_answerer({"NVIDIA_API_KEY": "k", "NVIDIA_MODEL": "m", "GROQ_API_KEY": "g"})
    assert spec is not None
    assert spec.provider == "groq"


def test_resolve_answerer_none_when_unconfigured() -> None:
    assert resolve_answerer({}) is None


def test_resolve_answerer_unknown_provider_raises() -> None:
    with pytest.raises(JudgeConfigError, match="LLM_PROVIDER"):
        resolve_answerer({"LLM_PROVIDER": "not-a-provider"})
