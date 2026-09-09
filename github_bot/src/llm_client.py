"""Unified LLM client for OpenCode2API AI bot: self-hosted gateway + CPA.

Dual-channel design (see github_bot/config/LLM_config.example.json):
- ``gateway``: opencode2api (OpenAI-compatible ``/v1/chat/completions``).
  Required because upstream Zen blocks APIKEY-direct free-model calls; the
  gateway serves anonymous free quota with auto-generated credentials on
  first start (no login needed). It can be long-lived or spun up
  ephemerally in CI pointing at ``127.0.0.1:10000``. Primary free model:
  ``muse-spark-1.3-contributor-free`` (reasoningEffort ``xhigh``), fallbacks
  ``big-pickle`` and other ``*-free`` models with live discovery via ``GET /models``.
- ``cpa``: CPA Responses API (``POST {base}/responses`` with 404 fallback to
  ``/chat/completions``). Priority ``gemini-3.8-flash-high`` then ``grok-4.6``
  (both ``high``), remaining models in listed order.

Session / thinking passthrough contract:
- Never strip ``signature`` / ``encrypted_content`` / ``redacted_thinking`` blocks
  from message history; they are forwarded verbatim so callers can chain turns.
- Every successful call records ``last_meta`` (``response_id``, ``model``,
  ``provider``) and ``chat_completion_with_meta()`` returns it alongside text so
  runners can persist ``previous_response_id`` chaining and echo session info.
- Gateway thinking signatures are empty by design; this client never forges them.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

ChatMessage = dict[str, Any]
ChatContent = str | list[dict[str, Any]]

DEFAULT_TIMEOUT_SECONDS = 300
DEFAULT_MIN_RESPONSE_CHARS = 0
DEFAULT_REJECT_FINISH_REASONS = ("length", "max_tokens", "content_filter")
# Gateway accepts xhigh (normalized to high server-side); CPA accepts high/max.
# xhigh is therefore valid in config, but normalized to high before CPA send.
VALID_REASONING_EFFORTS = {"low", "medium", "high", "max", "xhigh"}
MODEL_ID_ALLOWLIST = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
USER_AGENT = "opencode2api-ai-bot/1.0"

# Canonical internal model ids (gateway + CPA catalogs). Public comments must
# never contain these; keep in sync with LLM_config.example.json.
INTERNAL_MODEL_NAMES = (
    "gemini-3.8-flash-high",
    "gemini-3.7-flash-high",
    "gemini-3.6-flash-high",
    "grok-4.6",
    "grok-4.5",
    "grok-composer-2.5-fast",
    "grok-code",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "muse-spark-1.3-contributor-free",
    "big-pickle",
    "mimo-v2.5-free",
    "mimo-v2-flash-free",
    "mimo-v2-omni-free",
    "mimo-v2-pro-free",
    "deepseek-v4-flash-free",
    "nemotron-3-ultra-free",
    "nemotron-3.5-lightning-free",
    "nemotron-3-super-free",
    "north-mini-code-free",
    "kimi-k2.5-free",
    "ling-3.0-flash-free",
    "ling-2.6-flash-free",
    "ling-3.0-tiny-free",
    "laguna-s-2.1-free",
    "longcat-2.0-free",
    "minimax-m2.1-free",
    "minimax-m2.5-free",
    "minimax-m3-free",
    "glm-4.7-free",
    "glm-5-free",
    "qwen3.6-plus-free",
    "ring-2.6-1t-free",
    "trinity-large-preview-free",
    "hy3-free",
    "hy3-preview-free",
)


class LLMClientError(RuntimeError):
    """Raised when an LLM call fails or returns an unusable completion."""


_dotenv_loaded: bool = False


def reset_dotenv_loaded_state() -> None:
    """Test-only hook: clear the idempotency flag so a fresh scan can be forced."""
    global _dotenv_loaded
    _dotenv_loaded = False


def load_dotenv(dotenv_path: str | Path | None = None) -> dict[str, str]:
    """Minimal .env parser (stdlib only). Bypassed in CI; existing env always wins."""
    global _dotenv_loaded
    if os.environ.get("GITHUB_ACTIONS") or os.environ.get("CI"):
        return {}
    if dotenv_path is None and _dotenv_loaded:
        return {}
    loaded: dict[str, str] = {}
    paths: list[Path] = []
    if dotenv_path:
        paths.append(Path(dotenv_path))
    else:
        paths.extend([
            Path.cwd() / ".env",
            Path(__file__).resolve().parents[2] / ".env",
            Path(__file__).resolve().parents[1] / ".env",
        ])
    for path in paths:
        if path.is_file():
            try:
                for line in path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k and k not in os.environ:
                        os.environ[k] = v
                        loaded[k] = v
                break
            except Exception:
                pass
    if dotenv_path is None:
        _dotenv_loaded = True
    return loaded


def interpolate_env_vars(text: str) -> str:
    """Expand ${VAR} / $VAR placeholders from environment variables."""
    load_dotenv()

    def replacer(match: re.Match) -> str:
        var_name = match.group(1) or match.group(2)
        return os.environ.get(var_name, "")

    return re.sub(r"\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)", replacer, text)


def normalize_effort_for_provider(
    effort: str | None, api_type: str, base_url: str = ""
) -> str | None:
    """Normalize reasoning effort per provider wire format.

    Gateway understands ``xhigh`` natively; CPA Responses only accepts
    low/medium/high/max, so ``xhigh`` is sent as ``high`` on CPA paths.
    Responses-ness is determined by ``api_type`` OR a ``/responses`` suffixed
    base URL so endpoint routing and effort mapping never desync.
    """
    if not effort:
        return None
    low = str(effort).lower()
    is_responses = api_type == "responses" or base_url.rstrip("/").endswith("/responses")
    if is_responses and low == "xhigh":
        return "high"
    return low


def _redact_secrets(text: str) -> str:
    """Redact key material before anything is logged or posted publicly."""
    if not text:
        return ""
    redacted = re.sub(
        r"(?i)(api[_-]?key|apikey|token|password|secret)\s*([:=]\s*)(['\"]?)[^'\"\s,}]+(['\"]?)",
        r"\1\2\3[REDACTED]\4",
        text,
    )
    redacted = re.sub(r"Bearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", redacted)
    redacted = re.sub(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        redacted,
    )
    return redacted


def sanitize_public_error_text(text: str, *, max_chars: int = 500) -> str:
    """Make an error safe to publish: redact secrets, strip model/provider internals."""
    redacted = _redact_secrets(text or "")
    # Never advertise internal routing in public comments.
    for name in INTERNAL_MODEL_NAMES:
        redacted = re.sub(re.escape(name), "[model]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"(?i)\b(gateway|cpa|opencode)\b", "[provider]", redacted)
    redacted = re.sub(r"(GATEWAY|CPA|OPENCODE)_[A-Z_]*KEY", "[KEY_NAME]", redacted)
    return redacted[:max_chars]


def fetch_models_dev_free_ids(timeout_seconds: int = 8) -> set[str]:
    """Fetch https://models.dev/api.json and extract free opencode model IDs."""
    free_ids: set[str] = set()
    url = "https://models.dev/api.json"
    headers = {"User-Agent": USER_AGENT}
    try:
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            opencode_models = (data.get("opencode") or {}).get("models", {})
            for mid, info in opencode_models.items():
                cost = info.get("cost", {})
                if cost.get("input") == 0 or "free" in mid.lower():
                    free_ids.add(mid)
    except Exception:
        pass
    return free_ids


def sanitize_model_name_for_display(model_id: str) -> str:
    """Remove internal tier suffixes (-high, -free, -low) for clean display."""
    if not model_id:
        return ""
    return re.sub(r"-(high|free|extra-low|low)$", "", model_id, flags=re.IGNORECASE)


class LLMClient:
    """Multi-provider LLM client for gateway (OpenAI-compatible) and CPA (responses)."""

    def __init__(
        self,
        config_path: str | Path | None = None,
        fallback_models: list[str] | None = None,
        fallback_model: str = "gemini-3.8-flash-high",
        *,
        default_provider: str = "gateway",
        min_response_chars: int = DEFAULT_MIN_RESPONSE_CHARS,
        reject_finish_reasons: list[str] | set[str] | None = None,
        same_model_retry_on_length: int = 1,
        enable_streaming: bool = True,
    ) -> None:
        load_dotenv()
        self.default_provider = default_provider
        self.min_response_chars = int(min_response_chars)
        self.reject_finish_reasons = {
            str(item).lower()
            for item in (reject_finish_reasons or list(DEFAULT_REJECT_FINISH_REASONS))
        }
        self.same_model_retry_on_length = max(0, int(same_model_retry_on_length))
        self.enable_streaming = enable_streaming
        self.providers: dict[str, dict[str, Any]] = {}
        self.models: dict[str, dict[str, Any]] = {}
        self._discovery_cache: dict[str, list[str]] | None = None
        self._discovery_cache_time: float = 0.0
        self._discovery_ttl_seconds: float = 600.0
        self.last_meta: dict[str, Any] = {}

        root = Path(__file__).resolve().parents[1]
        example = root / "config" / "LLM_config.example.json"
        target = Path(config_path) if config_path else example
        if target.exists():
            self.load_config(target)
        else:
            raise LLMClientError(f"LLM configuration file not found: {target}")

        chain: list[str] = []
        if fallback_models:
            chain.extend(fallback_models)
        if fallback_model:
            chain.append(fallback_model)
        seen: set[str] = set()
        self.fallback_models: list[str] = []
        for mid in chain:
            if mid and mid not in seen:
                self.fallback_models.append(mid)
                seen.add(mid)

        default_pdata = self.providers.get(self.default_provider) or {}
        self.base_url = default_pdata.get("baseUrl", "")
        self.api_key = default_pdata.get("apikey", "")
        self.timeout_seconds = default_pdata.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS)

    def load_config(self, config_path: str | Path) -> None:
        """Load providers + model catalog with ${VAR} interpolation."""
        raw_text = Path(config_path).read_text(encoding="utf-8")
        interpolated = interpolate_env_vars(raw_text)
        data = json.loads(interpolated)

        self.providers = {}
        self.models = {}

        for provider_name, pdata in data.items():
            if not isinstance(pdata, dict):
                continue
            base_url = pdata.get("baseUrl") or ""
            if not base_url:
                if provider_name == "cpa":
                    base_url = os.environ.get("CPA_BASE_URL", "")
                elif provider_name == "gateway":
                    base_url = os.environ.get("GATEWAY_BASE_URL", "")
                elif provider_name == "opencode":
                    # Legacy alias: old configs pointed at Zen directly.
                    base_url = os.environ.get("OPENCODE_SERVER_URL", "")
            if base_url and not base_url.endswith("/"):
                base_url += "/"

            api_key = pdata.get("apikey") or ""
            if not api_key:
                if provider_name == "cpa":
                    api_key = os.environ.get("CPA_API_KEY", "")
                elif provider_name == "gateway":
                    # Canonical gateway key first, legacy OPENCODE_API_KEY second.
                    api_key = os.environ.get("GATEWAY_API_KEY", "") or os.environ.get(
                        "OPENCODE_API_KEY", ""
                    )
                elif provider_name == "opencode":
                    api_key = os.environ.get("OPENCODE_API_KEY", "")

            api_type = pdata.get("api", "openai-completions")
            timeout_seconds = int(pdata.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS))
            stream_enabled = bool(pdata.get("stream", True))

            self.providers[provider_name] = {
                "name": provider_name,
                "baseUrl": base_url,
                "apikey": api_key,
                "api": api_type,
                "stream": stream_enabled,
                "timeoutSeconds": timeout_seconds,
                "models": pdata.get("models", []),
            }

            for m in pdata.get("models", []):
                mid = m.get("id")
                if mid:
                    model_info = {**m, "_provider": provider_name}
                    effort = model_info.get("reasoningEffort")
                    if effort and str(effort).lower() not in VALID_REASONING_EFFORTS:
                        raise LLMClientError(
                            f"Invalid reasoningEffort {effort!r} for model {mid!r} "
                            f"(expected one of {sorted(VALID_REASONING_EFFORTS)})"
                        )
                    if "maxContextTokens" not in model_info and "contextWindow" in model_info:
                        model_info["maxContextTokens"] = model_info["contextWindow"]
                    if "maxOutputTokens" not in model_info and "maxTokens" in model_info:
                        model_info["maxOutputTokens"] = model_info["maxTokens"]
                    self.models[mid] = model_info

        # Dynamic default: prefer whichever channel actually has credentials.
        if getattr(self, "default_provider", "gateway") in {"gateway", "opencode"}:
            cpa = self.providers.get("cpa", {})
            gw = self.providers.get("gateway", {}) or self.providers.get("opencode", {})
            if cpa.get("apikey") and cpa.get("baseUrl") and not gw.get("apikey"):
                self.default_provider = "cpa"

        default_pdata = self.providers.get(self.default_provider) or {}
        self.base_url = default_pdata.get("baseUrl", "")
        self.api_key = default_pdata.get("apikey", "")
        self.timeout_seconds = default_pdata.get("timeoutSeconds", DEFAULT_TIMEOUT_SECONDS)

    def supports_input(self, model_id: str, modality: str) -> bool:
        """Check whether a model supports a given input modality."""
        model = self.models.get(model_id)
        if not model:
            return False
        inputs = model.get("input") or ["text"]
        return modality in inputs

    def discover_models(
        self, timeout_seconds: int = 8, *, force_refresh: bool = False
    ) -> dict[str, list[str]]:
        """Query each provider's /models endpoint and register live IDs (TTL 600s).

        Gateway: register every returned ID (self-hosted lineup is authoritative).
        Legacy ``opencode`` provider: only keep models.dev free / *-free IDs.
        CPA: register everything except image-generation models.
        """
        now = time.monotonic()
        if (
            not force_refresh
            and self._discovery_cache is not None
            and now - self._discovery_cache_time < self._discovery_ttl_seconds
        ):
            return dict(self._discovery_cache)

        discovered: dict[str, list[str]] = {}
        models_dev_free = fetch_models_dev_free_ids(timeout_seconds=timeout_seconds)

        for pname, pdata in self.providers.items():
            base_url = pdata.get("baseUrl") or ""
            api_key = pdata.get("apikey") or ""
            if not base_url or not api_key:
                continue
            models_url = f"{base_url.rstrip('/')}/models"
            headers = {"Authorization": f"Bearer {api_key}", "User-Agent": USER_AGENT}
            try:
                req = urllib.request.Request(models_url, headers=headers, method="GET")
                with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    items = (
                        data.get("data", [])
                        if isinstance(data, dict)
                        else (data if isinstance(data, list) else [])
                    )
                    model_list: list[str] = []
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        mid = item.get("id")
                        if not mid or not isinstance(mid, str):
                            continue
                        if not MODEL_ID_ALLOWLIST.fullmatch(mid):
                            sys.stderr.write(
                                f"[internal] ignoring non-conforming model id from {pname}: {mid!r}\n"
                            )
                            continue
                        if pname == "opencode":
                            is_free = (mid in models_dev_free) or ("free" in mid.lower())
                            if not is_free:
                                continue
                        if pname == "cpa" and (
                            mid.startswith("vertex/imagen") or mid.startswith("imagen-")
                        ):
                            continue
                        model_list.append(mid)
                        if mid not in self.models:
                            sys.stderr.write(
                                f"[internal] dynamically registered new model from {pname}: {mid}\n"
                            )
                            self.models[mid] = {
                                "id": mid,
                                "name": item.get("name", mid),
                                "description": f"Dynamically discovered model from {pname}",
                                "_provider": pname,
                                "input": ["text"],
                                "output": ["text"],
                            }
                    discovered[pname] = model_list
            except Exception:
                pass

        self._discovery_cache = discovered
        self._discovery_cache_time = time.monotonic()
        return dict(self._discovery_cache)

    def get_dynamic_fallback_chain(
        self, configured_fallbacks: list[str] | None = None
    ) -> list[str]:
        """Configured fallbacks first, then live gateway, then live CPA (no imagen)."""
        chain: list[str] = []
        for m in configured_fallbacks or []:
            if m and m not in chain:
                chain.append(m)
        try:
            discovered = self.discover_models()
        except Exception:
            discovered = {}
        for pname in ("gateway", "opencode"):
            for m in discovered.get(pname, []):
                if m not in chain:
                    chain.append(m)
        for m in discovered.get("cpa", []):
            if m not in chain and not m.startswith("vertex/imagen") and not m.startswith("imagen-"):
                chain.append(m)
        return chain

    def get_provider_for_model(self, model_id: str) -> dict[str, Any]:
        """Resolve the provider definition owning a model ID."""
        default_pname = getattr(self, "default_provider", "gateway")
        providers = getattr(self, "providers", {})
        models = getattr(self, "models", {})
        if model_id in models:
            pname = models[model_id].get("_provider", default_pname)
            return providers.get(pname, {})
        return providers.get(default_pname, {})

    def chat_completion(
        self,
        model_id: str,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        allow_fallback: bool = True,
        fallback_models: list[str] | None = None,
        timeout_seconds: int | None = None,
        min_chars: int | None = None,
        required_markers: list[str] | None = None,
        reasoning_effort: str | None = None,
    ) -> str:
        """Call a model with truncation retry + fallback chain. Returns text only."""
        text, _meta = self.chat_completion_with_meta(
            model_id,
            messages,
            temperature=temperature,
            max_tokens=max_tokens,
            allow_fallback=allow_fallback,
            fallback_models=fallback_models,
            timeout_seconds=timeout_seconds,
            min_chars=min_chars,
            required_markers=required_markers,
            reasoning_effort=reasoning_effort,
        )
        return text

    def chat_completion_with_meta(
        self,
        model_id: str,
        messages: list[ChatMessage],
        *,
        temperature: float = 0.2,
        max_tokens: int = 4096,
        allow_fallback: bool = True,
        fallback_models: list[str] | None = None,
        timeout_seconds: int | None = None,
        min_chars: int | None = None,
        required_markers: list[str] | None = None,
        reasoning_effort: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """Same as chat_completion but also returns session/response metadata.

        Meta always includes ``model`` + ``provider`` and, when the upstream
        supplies one, ``response_id``. Runners MUST persist ``response_id`` for
        ``previous_response_id`` chaining and MUST echo session/thinking metadata
        (never the secrets) in run summaries.
        """
        if reasoning_effort and str(reasoning_effort).lower() not in VALID_REASONING_EFFORTS:
            raise LLMClientError(
                f"Invalid reasoningEffort {reasoning_effort!r} "
                f"(expected one of {sorted(VALID_REASONING_EFFORTS)})"
            )
        effective_override = str(reasoning_effort).lower() if reasoning_effort else None
        candidates = [model_id]
        fallbacks_to_use = fallback_models if fallback_models is not None else getattr(
            self, "fallback_models", []
        )
        if allow_fallback:
            candidates.extend(m for m in fallbacks_to_use if m != model_id)

        errors: list[str] = []
        effective_min = (
            int(getattr(self, "min_response_chars", DEFAULT_MIN_RESPONSE_CHARS))
            if min_chars is None
            else int(min_chars)
        )
        models = getattr(self, "models", {})

        for candidate in candidates:
            needed = _required_modalities(messages)
            if needed and not all(self.supports_input(candidate, m) for m in needed):
                if candidate != model_id:
                    errors.append(f"{candidate}: skipped (no multimodal input support)")
                    continue
            provider = self.get_provider_for_model(candidate)
            pname = provider.get("name") or getattr(self, "default_provider", "gateway")
            base_url = provider.get("baseUrl") if provider else getattr(self, "base_url", "")
            api_key = provider.get("apikey") if provider else getattr(self, "api_key", "")
            if not base_url:
                errors.append(
                    f"{candidate}: skipped (provider '{pname}' has no base URL)"
                    if candidate != model_id
                    else f"Base URL is not configured for provider '{pname}'"
                )
                continue
            if not api_key:
                hint = "set GATEWAY_API_KEY (or legacy OPENCODE_API_KEY) or CPA_API_KEY"
                errors.append(
                    f"{candidate}: skipped (provider '{pname}' has no API key)"
                    if candidate != model_id
                    else f"API key is missing for provider '{pname}' ({hint})"
                )
                continue

            model_info = models.get(candidate, {"id": candidate})
            model_max = int(model_info.get("maxOutputTokens") or 65536)
            attempts = 1 + getattr(self, "same_model_retry_on_length", 1)
            current_max = min(max_tokens, model_max)
            for attempt in range(attempts):
                try:
                    text, meta = self._single_call(
                        candidate,
                        messages,
                        temperature=temperature,
                        max_tokens=current_max,
                        timeout_seconds=timeout_seconds,
                        min_chars=effective_min,
                        required_markers=required_markers,
                        reasoning_effort=effective_override,
                    )
                    meta = {**meta, "model": candidate, "provider": pname}
                    self.last_meta = meta
                    return text, meta
                except LLMClientError as exc:
                    reason = str(exc).lower()
                    if attempt + 1 < attempts and (
                        "finish_reason=length" in reason
                        or "truncated" in reason
                        or "too short" in reason
                    ):
                        current_max = min(max(current_max * 2, current_max + 2048), model_max)
                        continue
                    errors.append(f"{candidate}: {exc}")
                    break

        raise LLMClientError("; ".join(errors) if errors else f"No model candidates for {model_id}")

    def call_model(self, *args: Any, **kwargs: Any) -> str:
        """Backwards-compatible alias for chat_completion."""
        fallbacks = kwargs.pop("fallback_models", None)
        if fallbacks is None:
            fallbacks = getattr(self, "fallback_models", [])
        return self.chat_completion(*args, fallback_models=fallbacks, **kwargs)

    def _single_call(
        self,
        model_id: str,
        messages: list[ChatMessage],
        *,
        temperature: float,
        max_tokens: int,
        timeout_seconds: int | None,
        min_chars: int,
        required_markers: list[str] | None,
        reasoning_effort: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        provider = self.get_provider_for_model(model_id)
        base_url = provider.get("baseUrl") or getattr(self, "base_url", "")
        api_key = provider.get("apikey") or getattr(self, "api_key", "")
        api_type = provider.get("api", "openai-completions")
        timeout = (
            timeout_seconds
            if timeout_seconds is not None
            else provider.get("timeoutSeconds", getattr(self, "timeout_seconds", DEFAULT_TIMEOUT_SECONDS))
        )
        if not base_url:
            raise LLMClientError(f"Base URL is not configured for provider '{provider.get('name')}'")
        if not api_key:
            raise LLMClientError(
                f"API key is missing for provider '{provider.get('name')}' "
                "(set GATEWAY_API_KEY or CPA_API_KEY)"
            )

        models = getattr(self, "models", {})
        model_info = models.get(model_id, {"id": model_id})
        # Verbatim passthrough: never strip thinking signatures / encrypted blocks.
        prepared_messages = _prepare_messages_for_model(messages, model_info)
        raw_effort = reasoning_effort or model_info.get("reasoningEffort")
        effective_effort = normalize_effort_for_provider(
            str(raw_effort).lower() if raw_effort else None, api_type, base_url
        )
        thinking_cfg = model_info.get("thinking")

        if api_type == "responses" or base_url.rstrip("/").endswith("/responses"):
            endpoint = base_url if base_url.rstrip("/").endswith("/responses") else f"{base_url}responses"
            body: dict[str, Any] = {
                "model": model_id,
                "input": prepared_messages,
                "temperature": temperature,
                "max_output_tokens": max_tokens,
            }
            if effective_effort:
                body["reasoning_effort"] = effective_effort
        else:
            endpoint = (
                base_url
                if base_url.rstrip("/").endswith("/chat/completions")
                else f"{base_url}chat/completions"
            )
            body = {
                "model": model_id,
                "messages": prepared_messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            if effective_effort:
                body["reasoning_effort"] = effective_effort
            if thinking_cfg:
                body["thinking"] = thinking_cfg

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": USER_AGENT,
        }
        enable_stream = getattr(self, "enable_streaming", True) and provider.get("stream", True)
        if enable_stream:
            body["stream"] = True
            headers["Accept"] = "text/event-stream"

        _warn_if_plain_http(base_url)

        def on_http_error(exc: urllib.error.HTTPError) -> tuple[str, dict[str, Any]] | None:
            is_responses_endpoint = (
                api_type == "responses" or endpoint.rstrip("/").endswith("/responses")
            )
            if exc.code == 404 and is_responses_endpoint:
                text, fb_meta = self._fallback_openai_call(
                    base_url, api_key, model_id, prepared_messages,
                    temperature, max_tokens, timeout, min_chars,
                    required_markers, stream_enabled=enable_stream,
                    reasoning_effort=effective_effort, thinking=thinking_cfg,
                )
                return text, {**fb_meta, "endpoint": "chat/completions-fallback"}
            return None

        return self._post_and_parse(
            endpoint, body, headers, timeout, api_type, min_chars,
            required_markers, on_http_error=on_http_error,
        )

    def _fallback_openai_call(
        self,
        base_url: str,
        api_key: str,
        model_id: str,
        messages: list[ChatMessage],
        temperature: float,
        max_tokens: int,
        timeout: int,
        min_chars: int,
        required_markers: list[str] | None,
        stream_enabled: bool | None = None,
        *,
        reasoning_effort: str | None = None,
        thinking: Any | None = None,
    ) -> tuple[str, dict[str, Any]]:
        open_base = re.sub(r"/responses/?$", "/", base_url)
        endpoint = f"{open_base}chat/completions"
        body: dict[str, Any] = {"model": model_id, "messages": messages,
                "temperature": temperature, "max_tokens": max_tokens}
        if reasoning_effort:
            # Chat fallback wire only accepts high (never xhigh).
            body["reasoning_effort"] = "high" if str(reasoning_effort).lower() == "xhigh" else reasoning_effort
        if thinking is not None:
            body["thinking"] = thinking
        headers = {"Content-Type": "application/json",
                   "Authorization": f"Bearer {api_key}", "User-Agent": USER_AGENT}
        enable_stream = self.enable_streaming if stream_enabled is None else stream_enabled
        if enable_stream:
            body["stream"] = True
            headers["Accept"] = "text/event-stream"
        text, fb_meta = self._post_and_parse(
            endpoint, body, headers, timeout, "openai-completions",
            min_chars, required_markers, error_label="fallback",
        )
        return text, fb_meta

    def _post_and_parse(
        self,
        endpoint: str,
        body: dict[str, Any],
        headers: dict[str, str],
        timeout: int,
        api_type: str,
        min_chars: int,
        required_markers: list[str] | None,
        *,
        error_label: str = "",
        on_http_error: Callable[[urllib.error.HTTPError], tuple[str, dict[str, Any]] | None] | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """POST + parse/validate. Returns (text, meta with response_id when present)."""
        req = urllib.request.Request(
            endpoint, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
        )
        content = ""
        finish_reason = None
        response_id: str | None = None
        label = f"{error_label} " if error_label else ""
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                headers_obj = getattr(resp, "headers", None)
                content_type = headers_obj.get("Content-Type", "") if headers_obj is not None else ""
                if "text/event-stream" in content_type:
                    content, finish_reason, stream_meta = _parse_sse_stream(resp, api_type)
                    response_id = (stream_meta or {}).get("response_id")
                else:
                    payload = json.loads(resp.read().decode("utf-8"))
                    content, finish_reason, response_id = _extract_content_reason_id(payload, api_type)
        except urllib.error.HTTPError as exc:
            if on_http_error is not None:
                handled = on_http_error(exc)
                if handled is not None:
                    return handled
            detail = exc.read().decode("utf-8", errors="replace")
            safe = sanitize_public_error_text(f"HTTP {exc.code} from {endpoint}: {detail}")
            raise LLMClientError(safe) from exc
        except Exception as exc:
            raise LLMClientError(sanitize_public_error_text(f"LLM {label}request to {endpoint} failed: {exc}")) from exc

        rejection = unusable_completion_reason(
            content, finish_reason, min_chars=min_chars,
            required_markers=required_markers,
            reject_finish_reasons=getattr(self, "reject_finish_reasons", DEFAULT_REJECT_FINISH_REASONS),
        )
        if rejection:
            raise LLMClientError(rejection)
        meta: dict[str, Any] = {"endpoint": endpoint}
        if response_id:
            meta["response_id"] = response_id
        return content, meta


def _parse_sse_stream(resp: Any, api_type: str) -> tuple[str, str | None, dict[str, Any]]:
    """Parse SSE chunks (CPA responses + OpenAI chat deltas). Captures response id."""
    chunks: list[str] = []
    finish_reason: str | None = None
    response_id: str | None = None
    for raw_line in resp:
        line_str = raw_line.decode("utf-8", errors="replace").strip()
        if not line_str or line_str.startswith(":"):
            continue
        if line_str.startswith("data:"):
            data_body = line_str[5:].strip()
            if data_body == "[DONE]":
                break
            try:
                chunk = json.loads(data_body)
                if isinstance(chunk, dict) and not response_id:
                    for key in ("id", "response_id", "responseId"):
                        if isinstance(chunk.get(key), str):
                            response_id = str(chunk[key])
                            break
                    resp_obj = chunk.get("response")
                    if isinstance(resp_obj, dict) and isinstance(resp_obj.get("id"), str):
                        response_id = str(resp_obj["id"])
                piece = ""
                if chunk.get("type") == "response.output_text.delta" and "delta" in chunk:
                    piece = str(chunk["delta"])
                elif "delta" in chunk and isinstance(chunk["delta"], str):
                    piece = chunk["delta"]
                elif "choices" in chunk and isinstance(chunk["choices"], list) and chunk["choices"]:
                    c = chunk["choices"][0]
                    delta = c.get("delta") or {}
                    if "content" in delta and isinstance(delta["content"], str):
                        piece = delta["content"]
                    if c.get("finish_reason"):
                        finish_reason = str(c["finish_reason"]).lower()
                elif "response" in chunk and isinstance(chunk["response"], dict):
                    if chunk["response"].get("status"):
                        finish_reason = str(chunk["response"]["status"]).lower()
                if piece:
                    chunks.append(piece)
            except Exception:
                pass
    meta = {"response_id": response_id} if response_id else {}
    return "".join(chunks).strip(), finish_reason, meta


def _extract_content_reason_id(
    payload: dict[str, Any], api_type: str = "openai-completions"
) -> tuple[str, str | None, str | None]:
    """Extract (text, finish_reason, response_id) from JSON payloads."""
    response_id = _extract_response_id(payload)
    if "choices" in payload and isinstance(payload["choices"], list) and payload["choices"]:
        choice = payload["choices"][0]
        finish_reason = choice.get("finish_reason") or choice.get("native_finish_reason")
        content = (choice.get("message") or {}).get("content", "")
        return (
            _normalize_content(content),
            str(finish_reason).lower() if finish_reason else None,
            response_id,
        )
    if "output" in payload:
        texts: list[str] = []
        finish_reason = payload.get("finish_reason") or payload.get("status")
        for item in payload.get("output", []):
            if isinstance(item, dict):
                if item.get("type") == "message" and isinstance(item.get("content"), list):
                    for part in item["content"]:
                        if isinstance(part, dict) and part.get("type") == "output_text":
                            texts.append(str(part.get("text", "")))
                        elif isinstance(part, str):
                            texts.append(part)
                elif item.get("type") == "output_text" and "text" in item:
                    texts.append(str(item["text"]))
                elif "text" in item:
                    texts.append(str(item["text"]))
        return (
            "\n".join(texts).strip(),
            str(finish_reason).lower() if finish_reason else None,
            response_id,
        )
    if "content" in payload and isinstance(payload["content"], str):
        return payload["content"].strip(), None, response_id
    return "", "empty_payload", response_id


def _normalize_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
            else:
                parts.append(str(part))
        return "\n".join(parts).strip()
    return str(content).strip()


def _extract_response_id(payload: dict[str, Any]) -> str | None:
    """Read response/session id from any known envelope key (SSE + JSON parity)."""
    for key in ("id", "response_id", "responseId"):
        if isinstance(payload.get(key), str):
            return str(payload[key])
    resp_obj = payload.get("response")
    if isinstance(resp_obj, dict) and isinstance(resp_obj.get("id"), str):
        return str(resp_obj["id"])
    return None


def _warn_if_plain_http(base_url: str) -> None:
    """Warn once per process when a non-loopback gateway URL uses plain http."""
    if not base_url.startswith("http://"):
        return
    host = re.sub(r"^http://", "", base_url).split("/")[0].split("@")[-1].split(":")[0]
    if host in {"127.0.0.1", "localhost", "::1"}:
        return
    sys.stderr.write(
        "[warn] gateway base URL uses plain http:// for a non-loopback host; "
        "API keys travel in cleartext. Prefer https://.\n"
    )


def _required_modalities(messages: list[ChatMessage]) -> set[str]:
    """Return the set of non-text modalities actually present in messages."""
    needed: set[str] = set()
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            ptype = str(part.get("type", ""))
            if ptype in {"image_url", "input_image"} or "image_url" in part:
                needed.add("image")
            if ptype in {"video_url", "input_video"} or "video_url" in part:
                needed.add("video")
            if ptype in {"audio_url", "input_audio"} or "audio_url" in part:
                needed.add("audio")
    return needed


def _messages_have_media(messages: list[ChatMessage]) -> bool:
    """Backwards-compatible alias: True when any image/video/audio part is present."""
    return bool(_required_modalities(messages))


def _prepare_messages_for_model(
    messages: list[ChatMessage], model_info: dict[str, Any]
) -> list[ChatMessage]:
    """Forward message history verbatim except text-flattening for text-only models.

    Thinking/signature/encrypted blocks inside content lists are NEVER stripped:
    multimodal-capable models receive the original list untouched; text-only
    models get a flattened string that still notes omitted media without dropping
    surrounding text or signature fields carried as separate keys.
    """
    supports_multimodal = any(
        t in (model_info.get("input") or ["text"]) for t in ["image", "video", "audio"]
    )
    requires_string = bool((model_info.get("compat") or {}).get("requiresStringContent"))

    prepared: list[ChatMessage] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        passthrough = {k: v for k, v in msg.items() if k in {"signature", "encrypted_content", "redacted_thinking"}}
        if isinstance(content, list):
            if supports_multimodal and not requires_string:
                # Shallow-copy the list so downstream mutation cannot rewrite history.
                prepared.append({"role": role, "content": list(content), **passthrough})
            else:
                prepared.append({"role": role, "content": _flatten_content(content), **passthrough})
        else:
            prepared.append({"role": role, "content": str(content), **passthrough})
    return prepared


def _flatten_content(content: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            parts.append(str(part))
            continue
        ptype = part.get("type")
        if ptype == "text":
            parts.append(str(part.get("text", "")))
        elif ptype in {"thinking", "redacted_thinking"}:
            # Preserve reasoning text for text-only fallback; signature bytes stay
            # on the message envelope (see _prepare_messages_for_model).
            parts.append(str(part.get("thinking", part.get("text", ""))))
        elif ptype in {"image_url", "input_image"}:
            url = ((part.get("image_url") or {}).get("url")) or part.get("url") or ""
            parts.append(f"[image omitted for text-only model: {url[:120]}]")
        elif ptype in {"video_url", "input_video"}:
            url = ((part.get("video_url") or {}).get("url")) or part.get("url") or ""
            parts.append(f"[video omitted for text-only model: {url[:120]}]")
        elif ptype in {"audio_url", "input_audio"}:
            parts.append("[audio omitted for text-only model]")
        else:
            parts.append(str(part))
    return "\n".join(p for p in parts if p).strip()


def unusable_completion_reason(
    text: str,
    finish_reason: str | None,
    *,
    min_chars: int = DEFAULT_MIN_RESPONSE_CHARS,
    required_markers: list[str] | None = None,
    reject_finish_reasons: set[str] | None = None,
) -> str | None:
    """Validate that a completion is complete (not truncated) and meets markers."""
    reject_reasons = reject_finish_reasons or set(DEFAULT_REJECT_FINISH_REASONS)
    reason = (finish_reason or "").lower()
    if reason in reject_reasons:
        return f"unusable completion (finish_reason={reason})"
    content = (text or "").strip()
    if not content:
        return "LLM returned empty content"
    if len(content) < int(min_chars):
        return f"unusable completion (too short: {len(content)} < {min_chars} chars)"
    if content.endswith(("...", "…")) and len(content) < max(min_chars * 2, 600):
        return "unusable completion (appears truncated)"
    for marker in required_markers or []:
        if marker and marker.lower() not in content.lower():
            return f"unusable completion (missing required marker: {marker})"
    return None
