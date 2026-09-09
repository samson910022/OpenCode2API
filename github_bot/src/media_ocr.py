"""Media / log attachment discovery + OCR context for OpenCode2API AI bot.

Finds image/log references in issue/PR bodies and changed files, then asks the
configured multimodal model for a redacted summary. Failures are non-fatal and
yield empty context so triage/review can proceed without media.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

import re

DEFAULT_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".mp4", ".webm", ".mov", ".mp3", ".wav", ".m4a", ".ogg",
    ".log", ".txt",
)
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
URL_RE = re.compile(r"https?://[^\s)>\]]+")


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


def _build_content(ref: str, max_bytes: int) -> Any:
    """Build multimodal content parts for one ref (URL passthrough or data URL)."""
    clean = ref.rstrip(".,;:)]}")
    low = clean.lower().split("?")[0]
    if clean.startswith("http"):
        if any(low.endswith(ext) for ext in IMAGE_EXTENSIONS):
            return [
                {"type": "text", "text": f"SOURCE: {clean}\nDescribe what is visible (under 2000 chars)."},
                {"type": "image_url", "image_url": {"url": clean}},
            ]
        return (f"SOURCE: {clean}\nDescribe what is relevant in under 2000 chars. "
                "If unreachable, write OCR_TEXT: NOT_ENOUGH_INFO.")
    candidate = Path(clean)
    if candidate.is_file():
        try:
            if candidate.stat().st_size <= max_bytes and any(
                    low.endswith(ext) for ext in IMAGE_EXTENSIONS):
                data = base64.b64encode(candidate.read_bytes()).decode("ascii")
                return [
                    {"type": "text", "text": f"SOURCE: {clean}\nDescribe what is visible."},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{data}"}},
                ]
        except Exception:
            pass
        return f"SOURCE: {clean}\n(local file, describe relevance or NOT_ENOUGH_INFO)"
    return (f"SOURCE: {clean}\nDescribe what is relevant in under 2000 chars. "
            "If unreachable, write OCR_TEXT: NOT_ENOUGH_INFO.")
