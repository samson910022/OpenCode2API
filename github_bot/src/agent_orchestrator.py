"""Agent orchestration for OpenCode2API AI bot: triage / review / explain / scan / fix-plan.

Stdlib only. LLM access goes through :class:`llm_client.LLMClient` so the
gateway (free models) + CPA (priority models) fallback chain, thinking levels,
and session/response-id passthrough live in exactly one place.
"""

from __future__ import annotations

import concurrent.futures
import fnmatch
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from llm_client import (
    LLMClient,
    LLMClientError,
    sanitize_public_error_text,
)

BOT_DIR = Path(__file__).resolve().parents[1]


@dataclass
class ReviewContext:
    """Everything a review/explain run needs (already redacted + truncated)."""

    title: str = ""
    body: str = ""
    git_diff: str = ""
    changed_files: list[str] = field(default_factory=list)
    base_ref: str = ""
    head_ref: str = ""
    sensitive_files: list[str] = field(default_factory=list)
    media_context: str = ""
    thread_comments: list[dict[str, Any]] = field(default_factory=list)
    session_meta: dict[str, Any] = field(default_factory=dict)


def validate_triage_report(report: str, required_sections: list[str]) -> tuple[bool, list[str]]:
    """Check required triage headings, score range, and truncation signals."""
    missing: list[str] = []
    text = report or ""
    lowered = text.lower()
    for section in required_sections:
        # Match the heading at a line start to avoid prose false-positives.
        if not re.search(rf"(?m)^\s*{re.escape(section.lower())}\b", lowered):
            missing.append(section)
    if len(text.strip()) < 400:
        missing.append("MIN_LENGTH_400")
    score = re.search(r"ISSUE_QUALITY_SCORE\s*:\s*(\d{1,3})", text)
    if score is None:
        if "ISSUE_QUALITY_SCORE" in (required_sections or []):
            missing.append("SCORE_UNPARSEABLE")
    else:
        value = int(score.group(1))
        if not 0 <= value <= 100:
            missing.append("SCORE_OUT_OF_RANGE")
    if text.rstrip().endswith(("...", "…")) and len(text) < 2000:
        missing.append("APPEARS_TRUNCATED")
    return (len(missing) == 0, missing)


def is_triage_report_publishable(report: str, required_sections: list[str]) -> bool:
    """Publishable when the first four sections + score marker exist."""
    ok, _ = validate_triage_report(report, required_sections)
    if ok:
        return True
    head = (report or "").upper()
    must = ["CLASSIFICATION", "ACTIONABILITY", "SUMMARY", "ISSUE_QUALITY_SCORE"]
    return all(m in head for m in must) and len((report or "").strip()) >= 400


def scrub_internal_names(text: str, extra_names: list[str] | None = None) -> str:
    """Remove internal model/provider routing hints from public-facing text."""
    if not text:
        return ""
    try:
        from llm_client import INTERNAL_MODEL_NAMES
        names = list(INTERNAL_MODEL_NAMES)
    except Exception:
        names = [
            "gemini-3.8-flash-high", "grok-4.6", "claude-opus-4-6-thinking",
            "muse-spark-1.3-contributor-free", "big-pickle", "mimo-v2.5-free",
        ]
    names.extend(extra_names or [])
    out = text
    for name in names:
        out = re.sub(re.escape(name), "[model]", out, flags=re.IGNORECASE)
    out = re.sub(r"(?i)\b(gateway|cpa|opencode)\b", "[provider]", out)
    return out


class AgentOrchestrator:
    """Load bot config + prompts and run the issue/PR/scan/fix pipelines."""

    def __init__(
        self,
        bot_config_path: str | Path | None = None,
        llm_config_path: str | Path | None = None,
    ) -> None:
        config_path = Path(bot_config_path) if bot_config_path else BOT_DIR / "config" / "bot_config.json"
        self.config: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
        gate = self.config.get("llmResponseGate", {})
        self.llm = LLMClient(
            config_path=llm_config_path,
            fallback_models=self.config.get("fallbackModels", []),
            fallback_model=self.config.get("fallbackModel", "gemini-3.8-flash-high"),
            default_provider=self.config.get("defaultProvider", "gateway"),
            min_response_chars=int(gate.get("minResponseChars", 0)),
            reject_finish_reasons=gate.get("rejectFinishReasons"),
            same_model_retry_on_length=int(gate.get("sameModelRetryOnLength", 1)),
        )
        self._prompt_cache: dict[str, str] = {}
        self.last_session_meta: dict[str, Any] = {}

    # -- prompt loading ----------------------------------------------------
    def _read_prompt(self, prompt_file: str) -> str:
        if prompt_file not in self._prompt_cache:
            relative = prompt_file.removeprefix("./").removeprefix("/")
            path = (BOT_DIR / relative).resolve()
            # Contain reads inside github_bot/.
            if BOT_DIR not in path.parents and path != BOT_DIR:
                raise LLMClientError(f"promptFile escapes bot dir: {prompt_file}")
            self._prompt_cache[prompt_file] = path.read_text(encoding="utf-8")
        return self._prompt_cache[prompt_file]

    def _soul(self) -> str:
        for candidate in ("prompts/SOUL.md", "./prompts/SOUL.md"):
            path = BOT_DIR / candidate.lstrip("./")
            if path.is_file():
                return path.read_text(encoding="utf-8")
        return "You are the OpenCode2API review bot."

    def _run_role(
        self,
        role: str,
        user_prompt: str,
        *,
        required_markers: list[str] | None = None,
        min_chars: int | None = None,
    ) -> tuple[str, dict[str, Any]]:
        """Run one role. Thread-safe: never touches shared state; meta is returned.

        Callers assign ``self.last_session_meta`` on the joining thread, so
        parallel review roles cannot race on session/response IDs.
        """
        role_cfg = self.config["roles"][role]
        system = self._soul() + "\n\n" + self._read_prompt(role_cfg["promptFile"])
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user_prompt},
        ]
        text, meta = self.llm.chat_completion_with_meta(
            role_cfg["model"],
            messages,
            temperature=float(role_cfg.get("temperature", 0.2)),
            max_tokens=int(role_cfg.get("maxTokens", 4096)),
            min_chars=min_chars,
            required_markers=required_markers,
            reasoning_effort=role_cfg.get("reasoningEffort"),
        )
        # NOTE: self.llm.last_meta is diagnostic-only under concurrency; the
        # returned meta dict is authoritative.
        return text, {**meta, "role": role}

    # -- shared context builders -------------------------------------------
    def classify_sensitive_files(self, changed_files: list[str]) -> list[str]:
        """Flag changed paths matching sensitivePathGlobs."""
        globs = self.config.get("sensitivePathGlobs", [])
        hits: list[str] = []
        for path in changed_files or []:
            if any(fnmatch.fnmatch(path, g) for g in globs):
                hits.append(path)
        return hits

    def deterministic_findings(
        self, git_diff: str, changed_files: list[str]
    ) -> list[dict[str, str]]:
        """Local pre-checks: secrets, forbidden files, wire-shape keywords."""
        findings: list[dict[str, str]] = []
        secret_res = [
            (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private-key-material"),
            (r"(?i)(api[_-]?key|apikey)\s*[:=]\s*['\"]?[A-Za-z0-9._~+/-]{8,}", "possible-api-key"),
            (r"(?i)(password|passwd|secret)\s*[:=]\s*['\"]?[^'\"\s]+", "possible-password"),
        ]
        for i, line in enumerate((git_diff or "").splitlines(), 1):
            if line.startswith("+") and not line.startswith("+++"):
                for pattern, rule in secret_res:
                    if re.search(pattern, line):
                        findings.append({
                            "path": ",".join(changed_files[:3]) or "diff",
                            "line": str(i),
                            "rule": rule,
                            "evidence": "[REDACTED diff line]",
                        })
                        break
        forbidden = (".env", "config.json", "opencode.json", ".log", ".jks", ".keystore", ".pem")
        for path in changed_files or []:
            low = path.lower()
            if low == ".env" or low.endswith(tuple(f for f in forbidden if f != ".env")) or low == "config.json":
                findings.append({
                    "path": path, "line": "1",
                    "rule": "forbidden-file-staged",
                    "evidence": f"staged path {path} must not be committed",
                })
        return findings

    def assess_issue_field_quality(self, title: str, body: str) -> dict[str, str]:
        """Heuristic strong/weak/missing hints per triage dimension."""
        body_l = (body or "").lower()
        title_l = (title or "").lower()

        def has(*keys: str) -> bool:
            return any(k in body_l or k in title_l for k in keys)

        return {
            "clarity": "strong" if len((title or "").strip()) >= 12 and len((body or "").strip()) >= 80 else ("weak" if (body or "").strip() else "missing"),
            "version": "strong" if has("v1.", "version", "1.6", "commit", "sha") else "missing",
            "environment": "strong" if has("opencode_proxy_port", "openCode", "/health", "docker", "node", "port", "bind") else "missing",
            "reproduction": "strong" if has("curl", "repro", "steps", "expected", "actual") else "missing",
            "evidence": "strong" if has("log", "output", "error", "400", "401", "402", "429", "screenshot") else "missing",
        }

    def build_issue_repo_knowledge(self, max_chars: int = 3500) -> str:
        """Small repo knowledge pack (README/AGENTS/proxy entry) for triage grounding."""
        repo_root = BOT_DIR.parent
        parts: list[str] = []
        for rel in ("README.md", "AGENTS.md"):
            path = repo_root / rel
            if path.is_file():
                try:
                    parts.append(f"--- {rel}\n" + path.read_text(encoding="utf-8")[:1500])
                except Exception:
                    pass
        joined = "\n".join(parts)
        return joined[:max_chars]

    @staticmethod
    def format_thread_comments(comments: list[dict[str, Any]], max_chars: int = 12000) -> str:
        """Render prior thread comments; our own sticky reports are folded to extracts."""
        lines: list[str] = []
        for comment in comments or []:
            author = str(comment.get("author", "unknown"))
            body = str(comment.get("body", ""))
            is_bot = author.startswith("bot") or "<!-- OPENCODE2API_AI_" in body
            if is_bot and "<!-- OPENCODE2API_AI_" in body:
                # Fold our own sticky reports to their next-steps extract.
                extract = "\n".join(
                    line for line in body.splitlines()
                    if "NEXT_STEPS" in line.upper() or "MISSING" in line.upper()
                )[:500]
                body = f"[prior bot report folded; extract: {extract}]"
            lines.append(f"@{author}: {body[:1500]}")
        joined = "\n---\n".join(lines)
        return joined[:max_chars]

    @staticmethod
    def extract_prior_questions(comments: list[dict[str, Any]]) -> list[str]:
        """Collect questions already asked (human comments only) so triage asks NEW ones."""
        asked: list[str] = []
        seen: set[str] = set()
        for comment in comments or []:
            author = str(comment.get("author", "unknown"))
            if author.startswith("bot"):
                continue
            for line in str(comment.get("body", "")).splitlines():
                stripped = line.strip().lstrip("-*0123456789. ")
                if len(stripped) >= 8 and stripped.endswith("?") and stripped not in seen:
                    seen.add(stripped)
                    asked.append(stripped[:200])
                    if len(asked) >= 20:
                        return asked
        return asked

    def enrich_with_media_ocr(
        self, *, title: str, body: str, changed_files: list[str] | None = None,
    ) -> tuple[str, list[str]]:
        """Discover media refs and summarize via multimodal model (non-fatal)."""
        try:
            from media_ocr import discover_media_refs, summarize_media_with_llm

            cfg = self.config.get("mediaOcr", {})
            if not cfg.get("enabled", True):
                return "", []
            refs = discover_media_refs(
                title, body, changed_files,
                extensions=tuple(cfg.get("extensions", ())),
                max_items=int(cfg.get("maxItems", 4)),
            )
            if not refs:
                return "", []
            context = summarize_media_with_llm(
                self.llm, refs,
                timeout_seconds=int(cfg.get("timeoutSeconds", 120)),
                max_summary_chars=int(cfg.get("maxSummaryChars", 12000)),
                max_bytes_per_item=int(cfg.get("maxBytesPerItem", 5_000_000)),
            )
            return context, refs
        except Exception:
            return "", []

    # -- pipelines ----------------------------------------------------------
    def run_triage(
        self,
        title: str,
        body: str,
        *,
        media_context: str = "",
        thread_comments: list[dict[str, Any]] | None = None,
    ) -> str:
        """Issue investigation with quality validation + one repair retry."""
        triage_cfg = self.config.get("triage", {})
        required = triage_cfg.get("requiredSections", [])
        quality = self.assess_issue_field_quality(title, body)
        knowledge = self.build_issue_repo_knowledge()
        thread_text = self.format_thread_comments(
            thread_comments or [], max_chars=int(triage_cfg.get("maxThreadCommentChars", 12000))
        )
        prior = self.extract_prior_questions(thread_comments or [])
        user_prompt = (
            f"ISSUE TITLE: {title}\n\nISSUE BODY:\n{body}\n\n"
            f"FIELD_QUALITY_HINTS: {json.dumps(quality)}\n\n"
            f"REPO_KNOWLEDGE:\n{knowledge}\n\n"
            f"THREAD_COMMENTS:\n{thread_text or '(none)'}\n\n"
            f"QUESTIONS_ALREADY_ASKED:\n" + ("\n".join(f"- {q}" for q in prior) or "(none)") + "\n\n"
            f"MEDIA_CONTEXT:\n{media_context or '(none)'}\n"
        )
        report, meta = self._run_role(
            "triage_agent", user_prompt,
            required_markers=required[:4] or None,
            min_chars=int(triage_cfg.get("minResponseChars", 400)),
        )
        self.last_session_meta = meta
        ok, missing = validate_triage_report(report, required)
        if ok:
            return report
        # One repair attempt naming the missing sections explicitly.
        repair_prompt = (
            user_prompt + "\n\nYour previous draft was incomplete "
            f"(missing: {', '.join(missing)}). Re-emit the FULL report with every "
            f"required heading: {', '.join(required)}."
        )
        try:
            repaired, meta2 = self._run_role(
                "triage_agent", repair_prompt,
                required_markers=required[:4] or None,
                min_chars=int(triage_cfg.get("minResponseChars", 400)),
            )
            self.last_session_meta = meta2
            ok2, _ = validate_triage_report(repaired, required)
            if ok2:
                return repaired
        except Exception:
            pass
        if triage_cfg.get("failClosedOnIncomplete", True):
            return self.build_fail_closed_triage_stub(title, report)
        return report

    def build_fail_closed_triage_stub(self, title: str, partial: str) -> str:
        """Structured stub published when the model draft is unusable."""
        return (
            "CLASSIFICATION\n- `insufficient`\n\nACTIONABILITY\n- Band: `insufficient`\n"
            "- `BLOCKING_MISSING:` model IDs, `/health` output, repro curl\n"
            "- `NEXT_ACTION_REPORTER:` re-run with the diagnostics checklist\n"
            "- `NEXT_ACTION_MAINTAINER:` re-trigger `/triage` after info arrives\n\n"
            f"SUMMARY\n- Automated investigation of '{title}' did not complete; needs-info.\n\n"
            "EVIDENCE_USED\n- Title/body only; model draft failed validation.\n\n"
            "ROOT_CAUSE_HYPOTHESES\n- NOT_ENOUGH_INFO\n\nREPORTER_NEXT_STEPS\n"
            "- Post `GET /v1/models` IDs, `/health` output, minimal repro curl (names only, no secrets).\n\n"
            "MAINTAINER_NEXT_STEPS\n- Await reporter info; do not auto-close.\n\nSUGGESTED_LABELS\n- needs-info, needs-triage\n\n"
            "ISSUE_QUALITY_SCORE: 30 (insufficient)\n\nQUALITY_BREAKDOWN\n- pending full evidence\n\n"
            "MISSING_INFO\n- environment, reproduction, evidence\n\nRISK\n- low: incomplete triage only\n\n"
            "SECURITY_ROUTING\n- public (escalate to move-to-private if secrets appear)\n"
        )

    def _review_user_prompt(self, ctx: ReviewContext) -> str:
        return (
            f"PR TITLE: {ctx.title}\n\nPR BODY:\n{ctx.body}\n\n"
            f"BASE: {ctx.base_ref} HEAD: {ctx.head_ref}\n"
            f"CHANGED_FILES: {', '.join(ctx.changed_files)}\n"
            f"SENSITIVE_FILES: {', '.join(ctx.sensitive_files) or '(none)'}\n\n"
            f"DETERMINISTIC_PREFINDINGS: {json.dumps(self.deterministic_findings(ctx.git_diff, ctx.changed_files))}\n\n"
            f"MEDIA_CONTEXT:\n{ctx.media_context or '(none)'}\n\nDIFF:\n{ctx.git_diff}\n"
        )

    def run_multi_agent_review(self, ctx: ReviewContext) -> str:
        """Run reviewPipeline roles in parallel and aggregate verdicts."""
        pipeline: list[str] = self.config.get("reviewPipeline", [])
        user_prompt = self._review_user_prompt(ctx)
        results: dict[str, str] = {}
        metas: dict[str, dict[str, Any]] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(pipeline) or 1) as pool:
            future_to_role = {
                pool.submit(self._run_role, role, user_prompt): role for role in pipeline
            }
            for future in concurrent.futures.as_completed(future_to_role):
                role = future_to_role[future]
                try:
                    text, meta = future.result()
                    metas[role] = meta
                except Exception as exc:
                    text = (
                        f"VERDICT: COMMENT\nBLOCKING:\n- none\n"
                        f"SHOULD_FIX:\n- role {role} failed: {sanitize_public_error_text(str(exc))}\nNITS:\n- none"
                    )
                results[role] = text
        # Aggregate on the joining thread: no shared-state race.
        self.last_session_meta = {
            "role": "review:aggregate",
            "response_ids": [metas[r].get("response_id", "n/a") for r in pipeline if r in metas],
            "roles": {r: metas.get(r, {}) for r in pipeline},
        }
        # Only the VERDICT: line counts. Prose mentions of NEEDS_CHANGES must
        # not flip the outcome; unparseable outputs degrade to COMMENT.
        verdict = "APPROVE"
        for text in results.values():
            m = re.search(r"(?m)^\s*VERDICT\s*:\s*(APPROVE|NEEDS_CHANGES|COMMENT)", text.upper())
            parsed = m.group(1) if m else "COMMENT"
            if parsed == "NEEDS_CHANGES":
                verdict = "NEEDS_CHANGES"
                break
            if parsed == "COMMENT":
                verdict = "COMMENT"
        sections = [f"## {role}\n{results.get(role, '(missing)')}" for role in pipeline]
        sensitive = "\n".join(f"- {p}" for p in ctx.sensitive_files) or "- (none)"
        det = self.deterministic_findings(ctx.git_diff, ctx.changed_files)
        det_text = "\n".join(f"- {d['rule']}: {d['path']}:{d['line']}" for d in det) or "- (none)"
        return (
            f"## Verdict matrix\n- Roles: {', '.join(pipeline)}\n- FINAL_VERDICT: {verdict}\n\n"
            f"## Sensitive paths\n{sensitive}\n\n## Deterministic pre-checks\n{det_text}\n\n"
            + "\n\n".join(sections) + f"\n\nFINAL_VERDICT: {verdict}\n"
        )

    def run_explainer(self, ctx: ReviewContext) -> str:
        """Plain-language PR explanation (single role)."""
        prompt = self._review_user_prompt(ctx)
        text, meta = self._run_role("explainer_agent", prompt)
        self.last_session_meta = meta
        return text

    def run_scanner(self, findings: list[dict[str, str]]) -> str:
        """LLM re-check of deterministic scan findings (one call)."""
        if "scanner_agent" not in self.config.get("roles", {}):
            raise LLMClientError("scanner_agent role is not configured")
        payload = json.dumps(findings[:20], ensure_ascii=False)[:12000]
        prompt = (
            "Deterministic pre-scan findings (evidence already redacted):\n"
            f"{payload}\n\nConfirm or dispute each finding per the scanner role contract."
        )
        text, meta = self._run_role("scanner_agent", prompt)
        self.last_session_meta = meta
        return text

    def run_fix_plan(
        self, issue_title: str, issue_body: str, repo_context: str = "",
    ) -> tuple[str, str | None]:
        """Generate a fix plan plus an optional unified diff fenced block.

        Returns (plan_markdown, unified_diff_or_None). The diff is extracted
        from the first ```diff fenced block; callers must `git apply --check`
        before touching the tree.
        """
        prompt = (
            f"ISSUE TITLE: {issue_title}\n\nISSUE BODY:\n{issue_body[:8000]}\n\n"
            f"REPO_CONTEXT:\n{(repo_context or self.build_issue_repo_knowledge())[:4000]}\n\n"
            "Propose a minimal fix plan for OpenCode2API. Output sections: PLAN / "
            "FILES_TO_CHANGE / RISKS / TESTS. If and only if the fix is a small, "
            "safe, text-only change, append ONE ```diff fenced unified diff. "
            "Otherwise write: NO_DIFF: reason."
        )
        # Fix plans need a code-capable role; api_compat carries the wire-shape rules.
        role = "api_compat" if "api_compat" in self.config.get("roles", {}) else "explainer_agent"
        text, meta = self._run_role(role, prompt)
        self.last_session_meta = meta
        diff: str | None = None
        match = re.search(r"```diff\s*\n(.*?)```", text, flags=re.DOTALL)
        if match and "NO_DIFF" not in text:
            candidate = match.group(1).strip()
            if candidate.startswith("diff --git") or candidate.startswith("--- "):
                diff = candidate
        return text, diff
