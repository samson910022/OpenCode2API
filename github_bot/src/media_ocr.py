"""Media / log attachment discovery + OCR context for OpenCode2API AI bot.

Finds image/log references in issue/PR bodies and changed files, then asks the
configured multimodal model for a redacted summary. Failures are non-fatal and
yield empty context so triage/review can proceed without media.
"""

from __future__ import annotations

import base64
import os
import re
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".mp4", ".webm", ".mov", ".mp3", ".wav", ".m4a", ".ogg",
    ".log", ".txt",
)
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
# Text attachments are fetched inline (bounded); other media stays URL-only.
FETCHABLE_TEXT_EXTENSIONS = (".log", ".txt")
FETCH_MAX_BYTES = 200_000
FETCH_TIMEOUT_SECONDS = 15
URL_RE = re.compile(r"https?://[^\s)>\]]+")
# Local reads are confined to the repo worktree and never touch secret files.
REPO_ROOT = Path(__file__).resolve().parents[2]
SECRET_NAME_RE = re.compile(
    r"(^|/)(\.env(\..*)?|config\.json|opencode\.json|.*\.(pem|key|p12|pfx|jks|keystore))$", re.IGNORECASE
)


def discover_media_refs(
    title: str, body: str, changed_files: list[str] | None = None,
    *, extensions: tuple[str, ...] = DEFAULT_EXTENSIONS, max_items: int = 4,
) -> list[str]:
    """Collect up to max_items media/log references from text + file list."""
    seen: list[str] = []
    haystack = f"{title or ''}\n{body or ''}"
    for match in URL_RE.findall(haystack):
        low = match.lower().split("?")[0]
        if any(low.endswith(ext) for ext in extensions) or "user-attachments" in match:
            if match not in seen:
                seen.append(match)
    for path in changed_files or []:
        low = str(path).lower()
        if any(low.endswith(ext) for ext in extensions) and path not in seen:
            seen.append(str(path))
    return seen[:max_items]


def summarize_media_with_llm(
    llm_client: Any, refs: list[str], *, timeout_seconds: int = 120,
    max_summary_chars: int = 12000, model: str | None = None,
    max_bytes_per_item: int = 5_000_000,
) -> str:
    """Ask the multimodal LLM for a redacted OCR/summary of each ref. Never raises.

    Image URLs are sent as ``image_url`` content parts so the model actually
    sees them; local workspace files are base64 data-URLs (bounded by
    ``max_bytes_per_item``). ``model`` defaults to ``BOT_OCR_MODEL`` env or the
    configured media model.
    """
    if not refs or llm_client is None:
        return ""
    model_id = model or os.environ.get("BOT_OCR_MODEL", "gemini-3.8-flash-high")
    chunks: list[str] = []
    for ref in refs:
        try:
            content = _build_content(ref, max_bytes_per_item)
            messages = [
                {"role": "system", "content": (
                    "Summarize the attached media/log for a bug report. "
                    "Output sections: SOURCE / MEDIA_TYPE / OCR_TEXT / UI_SUMMARY / "
                    "RELEVANCE / PRIVACY_NOTES. Redact secrets, tokens, and personal data."
                )},
                {"role": "user", "content": content},
            ]
            text = llm_client.chat_completion(
                model_id, messages, temperature=0.1, max_tokens=2048,
                timeout_seconds=timeout_seconds, allow_fallback=True,
            )
            chunks.append(f"--- media: {ref}\n{text[:3000]}")
        except Exception as exc:
            chunks.append(f"--- media: {ref}\n[ocr unavailable: {type(exc).__name__}]")
    joined = "\n".join(chunks)
    return joined[:max_summary_chars] if len(joined) > max_summary_chars else joined


def _fetch_text_attachment(url: str, max_bytes: int = FETCH_MAX_BYTES) -> str | None:
    """Fetch a bounded text attachment (.log/.txt). None when unusable."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "opencode2api-ai-bot/1.0"},
                                     method="GET")
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_SECONDS) as resp:
            raw = resp.read(max_bytes + 1)
    except Exception:
        return None
    if len(raw) > max_bytes:
        raw = raw[:max_bytes]
    try:
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return None


def _redact_text(text: str) -> str:
    """Redact key material from fetched text before it reaches the model."""
    redacted = re.sub(
        r"(?i)(api[_-]?key|apikey|token|password|secret)\s*([:=]\s*)(['\"]?)[^'\"\s,}]+(['\"]?)",
        r"\1\2\3[REDACTED]\4", text)
    redacted = re.sub(r"Bearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", redacted)
    return redacted


def _contained_repo_path(ref: str) -> Path | None:
    """Resolve a repo-relative ref inside REPO_ROOT; None when unsafe."""
    if SECRET_NAME_RE.search(ref):
        return None
    try:
        resolved = (REPO_ROOT / ref).resolve()
    except Exception:
        return None
    if REPO_ROOT not in resolved.parents and resolved != REPO_ROOT:
        return None
    name = resolved.name
    if name.startswith(".") or not resolved.is_file():
        return None
    return resolved


def _build_content(ref: str, max_bytes: int) -> Any:
    """Build multimodal content for one ref (images as parts, text inline)."""
    clean = ref.rstrip(".,;:)]}")
    low = clean.lower().split("?")[0]
    if clean.startswith("http"):
        if any(low.endswith(ext) for ext in IMAGE_EXTENSIONS):
            return [
                {"type": "text", "text": f"SOURCE: {clean}\nDescribe what is visible (under 2000 chars)."},
                {"type": "image_url", "image_url": {"url": clean}},
            ]
        if any(low.endswith(ext) for ext in FETCHABLE_TEXT_EXTENSIONS):
            fetched = _fetch_text_attachment(clean)
            if fetched is not None:
                return (f"SOURCE: {clean}\nATTACHMENT_CONTENT:\n{_redact_text(fetched)}\n"
                        "Summarize what is relevant in under 2000 chars.")
            return (f"SOURCE: {clean}\n(fetch failed; describe relevance from context or write "
                    "OCR_TEXT: NOT_ENOUGH_INFO)")
        # Audio/video containers are not fetched; the model works from context.
        return (f"SOURCE: {clean}\n(content not fetched for this media type; describe likely "
                "relevance from surrounding context or write OCR_TEXT: NOT_ENOUGH_INFO)")
    candidate = _contained_repo_path(clean)
    if candidate is not None:
        try:
            if candidate.stat().st_size <= max_bytes and any(
                    low.endswith(ext) for ext in IMAGE_EXTENSIONS):
                data = base64.b64encode(candidate.read_bytes()).decode("ascii")
                return [
                    {"type": "text", "text": f"SOURCE: {clean}\nDescribe what is visible."},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{data}"}},
                ]
            if candidate.stat().st_size <= FETCH_MAX_BYTES and any(
                    low.endswith(ext) for ext in FETCHABLE_TEXT_EXTENSIONS):
                return (f"SOURCE: {clean}\nATTACHMENT_CONTENT:\n"
                        f"{_redact_text(candidate.read_text(encoding='utf-8', errors='replace')[:FETCH_MAX_BYTES])}\n"
                        "Summarize what is relevant in under 2000 chars.")
        except Exception:
            pass
        return f"SOURCE: {clean}\n(local file, describe relevance or NOT_ENOUGH_INFO)"
    return (f"SOURCE: {clean}\n(unreadable or outside repo; describe relevance from context "
            "or write OCR_TEXT: NOT_ENOUGH_INFO)")
