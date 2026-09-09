#!/usr/bin/env python3
"""GitHub Actions entrypoint for OpenCode2API AI bot.

Modes: review / triage / comment (slash-command router) / explain / scan
(scheduled repo scan with auto-issue) / fix-plan (issue fix proposal with
opt-in draft PR). Stdlib only. Public comments never include model or
provider names; session/response IDs ARE echoed so callers can chain
previous_response_id within the 30min TTL.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from agent_orchestrator import (
    AgentOrchestrator,
    ReviewContext,
    is_triage_report_publishable,
    scrub_internal_names,
    validate_triage_report,
)
from llm_client import sanitize_public_error_text

BOT_DIR = Path(__file__).resolve().parents[1]
CONFIG = json.loads((BOT_DIR / "config" / "bot_config.json").read_text(encoding="utf-8"))
SESSION_TTL_NOTE = "Session: response_id={rid} (chain via previous_response_id, 30min TTL)."


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OpenCode2API GitHub AI bot")
    parser.add_argument("--mode",
                        choices=["review", "triage", "comment", "explain", "scan", "fix-plan"],
                        default="review")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print output instead of posting to GitHub")
    parser.add_argument("--apply-fix", action="store_true",
                        help="fix-plan: apply clean diffs and open a draft PR")
    parser.add_argument("--issue", type=int, default=0, help="fix-plan target issue number")
    args = parser.parse_args(argv)

    has_creds = bool(
        os.environ.get("GATEWAY_API_KEY")
        or os.environ.get("OPENCODE_API_KEY")
        or (os.environ.get("CPA_API_KEY") and os.environ.get("CPA_BASE_URL"))
    )
    if not has_creds and not args.dry_run:
        print("GATEWAY_API_KEY (or legacy OPENCODE_API_KEY) or CPA_API_KEY + CPA_BASE_URL is required",
              file=sys.stderr)
        return 2

    orchestrator = AgentOrchestrator()
    mode = args.mode

    if mode == "comment":
        resolved = _resolve_comment_mode(os.environ.get("COMMENT_BODY", ""))
        if resolved is None:
            print("No supported slash command found; skipping")
            return 0
        mode = resolved

    if mode in {"review", "explain"} and not _is_pull_request_context():
        print(f"Non-PR context detected; routing `{mode}` to issue investigation")
        mode = "triage"

    if mode == "triage":
        return _run_triage(orchestrator, dry_run=args.dry_run)
    if mode == "scan":
        return _run_scan(orchestrator, dry_run=args.dry_run)
    if mode == "fix-plan":
        return _run_fix_plan(orchestrator, dry_run=args.dry_run,
                             apply_fix=args.apply_fix, issue_number=args.issue)
    ctx = _build_review_context(orchestrator)
    if mode == "explain":
        report = orchestrator.run_explainer(ctx)
        _emit_session_meta(orchestrator.last_session_meta)
        footer = _session_footer(orchestrator.last_session_meta)
        return _publish(scrub_internal_names(report) + f"\n\n{footer}",
                        marker=CONFIG["commandMarker"], dry_run=args.dry_run)
    report = orchestrator.run_multi_agent_review(ctx)
    _emit_session_meta(orchestrator.last_session_meta)
    footer = _session_footer(orchestrator.last_session_meta)
    marker = CONFIG["commentMarker"] if mode == "review" else CONFIG["commandMarker"]
    return _publish(scrub_internal_names(report) + f"\n\n{footer}",
                    marker=marker, dry_run=args.dry_run)


# -- triage ---------------------------------------------------------------
def _run_triage(orchestrator: AgentOrchestrator, *, dry_run: bool) -> int:
    title = os.environ.get("ISSUE_TITLE") or _event_field("issue", "title") or "Issue"
    body = os.environ.get("ISSUE_BODY") or _event_field("issue", "body") or ""
    body = _redact_secrets(body)
    max_body = int(CONFIG.get("maxIssueBodyChars", 40000))
    if len(body) > max_body:
        body = body[:max_body] + "\n\n[issue body truncated for model context]\n"
    thread_comments = _fetch_issue_comments()
    ocr_body = body + ("\n" + "\n".join(str(c.get("body") or "") for c in thread_comments) if thread_comments else "")
    media_context, _labels = orchestrator.enrich_with_media_ocr(title=title, body=ocr_body, changed_files=[])
    report = orchestrator.run_triage(title, body, media_context=media_context, thread_comments=thread_comments)
    _emit_session_meta(orchestrator.last_session_meta)
    footer = _session_footer(orchestrator.last_session_meta)
    return _publish_triage(orchestrator, title, scrub_internal_names(report) + f"\n\n{footer}",
                           dry_run=dry_run)


def _publish_triage(orchestrator: AgentOrchestrator, title: str, report: str, *, dry_run: bool) -> int:
    required = CONFIG.get("triage", {}).get("requiredSections", [])
    ok, missing = validate_triage_report(report, required)
    if not ok and not is_triage_report_publishable(report, required):
        # Fail closed: replace the unusable draft with a structured stub.
        report = orchestrator.build_fail_closed_triage_stub(title, report)
    code = _publish(report, marker=CONFIG["triageMarker"], dry_run=dry_run)
    if code == 0:
        _maybe_apply_suggested_labels(report, dry_run=dry_run)
    return code


# -- scan (scheduled auto-issue) ------------------------------------------
def _run_scan(orchestrator: AgentOrchestrator, *, dry_run: bool) -> int:
    from repo_scan import collect_findings

    scan_cfg = CONFIG.get("scan", {})
    configured_max = int(scan_cfg.get("maxIssuesPerRun", 3))
    try:
        requested = int(os.environ.get("SCAN_MAX_ISSUES", configured_max))
    except ValueError:
        requested = configured_max
    # Manual dispatch cannot exceed the configured per-run cap.
    max_issues = max(0, min(requested, configured_max))
    findings = collect_findings()
    # Belt and braces: deterministic layer already sorts, re-sort by severity.
    rank = {"blocking": 0, "should-fix": 1, "nit": 2}
    findings = sorted(findings, key=lambda d: (rank.get(d.get("severity", ""), 9), d.get("fingerprint", "")))
    if not findings:
        print("scan: no deterministic findings")
        return 0
    try:
        assessment = scrub_internal_names(orchestrator.run_scanner(findings))
        _emit_session_meta(orchestrator.last_session_meta)
    except Exception as exc:
        print(f"scan: LLM re-check unavailable ({sanitize_public_error_text(str(exc))}); using deterministic set")
        assessment = ""
    existing = _list_open_issues() if not dry_run else []
    created = 0
    # Dedupe-aware counting: stop after max_issues NEW issues, not slices.
    for item in findings:
        if created >= max_issues:
            break
        fp = item["fingerprint"]
        if any(fp in (i.get("title", "") + i.get("body", "")) for i in existing):
            print(f"scan: dedupe hit, skipping {fp}")
            continue
        title = f"[AI scan] {fp.split(':')[1] if ':' in fp else 'finding'} ({item['location']})"
        body = (
            f"{CONFIG.get('scanMarker', '<!-- OPENCODE2API_AI_SCAN_REPORT -->')}\n\n"
            f"Fingerprint: `{fp}`\nSeverity: `{item['severity']}`\n"
            f"Location: `{item['location']}`\nEvidence: `{item['evidence']}`\n\n"
            f"LLM_ASSESSMENT:\n{(assessment[:2000] if assessment else '(re-check unavailable)')}\n\n"
            f"{_session_footer(orchestrator.last_session_meta)}\n"
        )
        if dry_run:
            print(f"--- dry-run issue ---\n# {title}\n{body}\n")
            created += 1
            continue
        try:
            _github_request("POST", f"/repos/{_repo()}/issues",
                            {"title": title[:120], "body": body[:6000],
                             "labels": ["needs-triage"]})
            print(f"scan: opened issue for {fp}")
            created += 1
        except Exception as exc:
            print(f"scan: failed to open issue for {fp}: {sanitize_public_error_text(str(exc))}",
                  file=sys.stderr)
    print(f"scan: {created} issue(s) created from {len(findings)} finding(s)")
    return 0


def _list_open_issues() -> list[dict[str, Any]]:
    try:
        data = _github_request("GET", f"/repos/{_repo()}/issues?state=open&per_page=100")
        return data if isinstance(data, list) else []
    except Exception as exc:
        print(f"scan: list issues failed: {sanitize_public_error_text(str(exc))}", file=sys.stderr)
        return []


# -- fix-plan (proposal + opt-in draft PR) ---------------------------------
def _run_fix_plan(orchestrator: AgentOrchestrator, *, dry_run: bool,
                  apply_fix: bool, issue_number: int) -> int:
    number = issue_number or _event_issue_number() or int(os.environ.get("ISSUE_NUMBER", 0) or 0)
    if not number:
        print("fix-plan requires an issue number (--issue or issue_comment context)", file=sys.stderr)
        return 2
    issue = _github_request("GET", f"/repos/{_repo()}/issues/{number}") if not dry_run else {
        "title": os.environ.get("ISSUE_TITLE", f"Issue #{number}"),
        "body": os.environ.get("ISSUE_BODY", ""),
    }
    title = str(issue.get("title", f"Issue #{number}"))
    body = _redact_secrets(str(issue.get("body", ""))[:8000])
    plan, diff = orchestrator.run_fix_plan(title, body)
    _emit_session_meta(orchestrator.last_session_meta)
    comment = (
        f"{CONFIG['commandMarker']}\n\n## Fix plan for #{number}\n\n"
        f"{scrub_internal_names(plan)[:8000]}\n\n{_session_footer(orchestrator.last_session_meta)}\n"
    )
    if dry_run or not apply_fix or not diff:
        if not diff:
            comment += "\nNO_DIFF: plan only (no safe unified diff proposed).\n"
        print(comment)
        return 0 if dry_run else _comment_on_issue(number, comment)
    # Apply path: branch + git apply --check + commit + push + draft PR.
    fp_short = re.sub(r"[^a-z0-9-]", "-", title.lower())[:30].strip("-") or "fix"
    branch = f"ai-fix/issue-{number}-{fp_short}"
    try:
        _git(["checkout", "-B", branch])
        proc = subprocess.run(["git", "apply", "--check", "-"], input=diff,
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            msg = comment + f"\nDiff did not apply cleanly; leaving plan only.\n```\n{proc.stderr[:1000]}\n```\n"
            print(msg)
            _git(["checkout", "-"])
            try:
                _git(["branch", "-D", branch])
            except Exception:
                pass
            return _comment_on_issue(number, msg)
        subprocess.run(["git", "apply", "-"], input=diff, check=True, text=True, timeout=60)
        _git(["add", "-A"])
        _git(["commit", "-m", f"fix(issue-{number}): AI-proposed draft fix (human review required)"])
        _git(["push", "-u", "origin", branch])
        pr = _github_request("POST", f"/repos/{_repo()}/pulls", {
            "title": f"[AI draft] Fix #{number}: {title}"[:120],
            "head": branch, "base": _default_branch(), "body": comment[:6000], "draft": True,
        })
        print(f"fix-plan: opened draft PR #{pr.get('number')} on {branch}")
        return _comment_on_issue(number, comment + f"\nDraft PR: #{pr.get('number')}\n")
    except Exception as exc:
        safe = sanitize_public_error_text(str(exc))
        print(f"fix-plan failed: {safe}", file=sys.stderr)
        # The plan must still reach the issue even when git/PR steps fail.
        try:
            _comment_on_issue(number, comment + f"\n[fix-plan automation failed: {safe}]\n")
        except Exception:
            pass
        return 1
    finally:
        try:
            _git(["checkout", "-"])
        except Exception:
            pass


def _git(args: list[str]) -> str:
    proc = subprocess.run(["git"] + args, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr[:300]}")
    return proc.stdout


# -- publish / labels / session --------------------------------------------
def _session_footer(meta: dict[str, Any]) -> str:
    meta = meta or {}
    if isinstance(meta.get("roles"), dict):
        rids = meta.get("response_ids") or [
            (m or {}).get("response_id", "n/a") for m in meta["roles"].values()
        ]
        rid = ",".join(r for r in rids if r) or "n/a"
    else:
        rid = meta.get("response_id", "n/a")
    return SESSION_TTL_NOTE.format(rid=rid) + " model=[model] provider=[provider]."


def _emit_session_meta(meta: dict[str, Any]) -> None:
    meta = meta or {}
    if isinstance(meta.get("roles"), dict):
        for role, sub in meta["roles"].items():
            rid = (sub or {}).get("response_id", "n/a")
            print(f"[session] role={role} response_id={rid} (echo for previous_response_id chaining)")
        return
    rid = meta.get("response_id", "n/a")
    role = meta.get("role", "-")
    # Values echoed are IDs only — never keys or tool outputs.
    print(f"[session] role={role} response_id={rid} (echo for previous_response_id chaining)")


def _publish(report: str, *, marker: str, dry_run: bool) -> int:
    body = f"{marker}\n\n{report}\n"
    repo = _repo()
    if dry_run or not os.environ.get("GITHUB_TOKEN") or not repo:
        print(body)
        return 0
    number = _event_issue_number()
    if number is None:
        print("No issue/PR number in event; printing instead:\n" + body)
        return 0
    comments = _github_request("GET", f"/repos/{repo}/issues/{number}/comments?per_page=100")
    existing_id = None
    for comment in comments if isinstance(comments, list) else []:
        if marker in str(comment.get("body", "")):
            existing_id = comment.get("id")
            break
    if existing_id:
        _github_request("PATCH", f"/repos/{_repo()}/issues/comments/{existing_id}", {"body": body[:60000]})
        print(f"Updated comment {existing_id} on #{number}")
    else:
        _github_request("POST", f"/repos/{_repo()}/issues/{number}/comments", {"body": body[:60000]})
        print(f"Created comment on #{number}")
    return 0


def _maybe_apply_suggested_labels(report: str, *, dry_run: bool) -> None:
    triage_cfg = CONFIG.get("triage", {})
    if not triage_cfg.get("applySuggestedLabels"):
        return
    allow = set(triage_cfg.get("labelAllowlist", []))
    suggest_only = set(triage_cfg.get("suggestOnlyLabels", ["security"]))
    # Support both `SUGGESTED_LABELS\nbug, ...` and `SUGGESTED_LABELS: bug, ...`.
    m = re.search(r"SUGGESTED_LABELS\s*[:：]?\s*\n?(.+?)(?:\n\s*\n|\n[A-Z_]{3,}\s*\n|\Z)",
                  report, flags=re.DOTALL)
    if not m:
        return
    raw = m.group(1)
    candidates: set[str] = set()
    for line in raw.splitlines()[:8]:
        for token in re.split(r"[,，]", line):
            token = token.strip(" -`'\"*").lower()
            if token and token not in {"none", "n/a", "na", "(none)"}:
                candidates.add(token)
    labels = sorted((candidates & allow) - suggest_only)
    if not labels:
        return
    if dry_run or not os.environ.get("GITHUB_TOKEN"):
        print(f"[dry-run] would apply labels: {labels}")
        return
    number = _event_issue_number()
    if number is None:
        return
    try:
        _github_request("POST", f"/repos/{_repo()}/issues/{number}/labels", {"labels": labels})
        print(f"Applied labels {labels} to #{number}")
    except Exception as exc:
        print(f"label apply failed (non-fatal): {sanitize_public_error_text(str(exc))}", file=sys.stderr)


def _comment_on_issue(number: int, body: str) -> int:
    if not os.environ.get("GITHUB_TOKEN"):
        print(body)
        return 0
    _github_request("POST", f"/repos/{_repo()}/issues/{number}/comments", {"body": body[:60000]})
    return 0


# -- github plumbing ---------------------------------------------------------
def _repo() -> str:
    return os.environ.get("GITHUB_REPOSITORY", "")


def _event() -> dict[str, Any]:
    path = os.environ.get("GITHUB_EVENT_PATH", "")
    if path and Path(path).is_file():
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _event_field(*keys: str) -> Any:
    node: Any = _event()
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def _event_issue_number() -> int | None:
    for getter in (lambda: _event_field("issue", "number"),
                   lambda: _event_field("pull_request", "number")):
        try:
            value = getter()
            if value is not None:
                return int(value)
        except (TypeError, ValueError):
            pass
    return None


def _is_pull_request_context() -> bool:
    if os.environ.get("PR_BASE_SHA") or os.environ.get("PR_HEAD_SHA"):
        return True
    if _event_field("pull_request", "number") is not None:
        return True
    if _event_field("issue", "pull_request") is not None:
        return True
    return (os.environ.get("GITHUB_EVENT_NAME") or "").lower() in {"pull_request", "pull_request_target"}


def _resolve_comment_mode(comment_body: str) -> str | None:
    text = (comment_body or "").lower()
    # Word-boundary matching so prose like "/fixup" or pasted URLs don't trigger.
    if re.search(r"/fix\b", text):
        return "fix-plan"
    if re.search(r"/review\b", text):
        return "review"
    if re.search(r"/explain\b", text):
        return "explain"
    if re.search(r"/triage\b", text):
        return "triage"
    return None


def _default_branch() -> str:
    candidates = CONFIG.get("defaultBranchCandidates", ["main"])
    return candidates[0] if candidates else "main"


def _redact_secrets(text: str) -> str:
    if not text:
        return ""
    redacted = re.sub(
        r"(?i)(api[_-]?key|apikey|token|password|secret)\s*([:=]\s*)(['\"]?)[^'\"\s,}]+(['\"]?)",
        r"\1\2\3[REDACTED]\4", text)
    redacted = re.sub(r"Bearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [REDACTED]", redacted)
    redacted = re.sub(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]", redacted)
    return redacted


def _github_request(method: str, path: str, payload: Any | None = None) -> Any:
    token = os.environ.get("GITHUB_TOKEN", "")
    url = f"https://api.github.com{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opencode2api-ai-bot/1.0",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"GitHub API {method} {path} -> HTTP {exc.code}: {detail}") from exc


def _fetch_issue_comments() -> list[dict[str, Any]]:
    if os.environ.get("ISSUE_COMMENTS_JSON"):
        try:
            fixture = json.loads(os.environ["ISSUE_COMMENTS_JSON"])
            normalized: list[dict[str, Any]] = []
            for item in fixture if isinstance(fixture, list) else []:
                if isinstance(item, dict):
                    normalized.append({
                        "author": str(item.get("author", "unknown")),
                        "body": _redact_secrets(str(item.get("body", ""))),
                    })
            return normalized
        except Exception:
            return []
    if not os.environ.get("GITHUB_TOKEN"):
        return []
    number = _event_issue_number()
    if number is None:
        return []
    cfg = CONFIG.get("triage", {}).get("thread", {})
    max_comments = int(cfg.get("maxComments", 30))
    max_chars = int(cfg.get("maxChars", 20000))
    # Two pages (newest-first API returns oldest first per page; cap total).
    items: list[Any] = []
    for page in (1, 2):
        try:
            data = _github_request(
                "GET", f"/repos/{_repo()}/issues/{number}/comments?per_page=100&page={page}")
        except Exception:
            break
        if not isinstance(data, list) or not data:
            break
        items.extend(data)
        if len(data) < 100:
            break
    comments: list[dict[str, Any]] = []
    total = 0
    for item in items[:max_comments]:
        body = _redact_secrets(str(item.get("body", "")))
        if cfg.get("excludeBotMarkers") and "<!-- OPENCODE2API_AI_" in body:
            author = "bot(sticky)"
        else:
            author = str((item.get("user") or {}).get("login", "unknown"))
        if total + len(body) > max_chars:
            # Keep a truncated tail instead of dropping the boundary comment.
            room = max_chars - total
            if room > 200:
                comments.append({"author": author, "body": body[:room] + "\n[comment truncated]"})
            break
        total += len(body)
        comments.append({"author": author, "body": body})
    return comments


def _build_review_context(orchestrator: AgentOrchestrator) -> ReviewContext:
    title = _event_field("pull_request", "title") or _event_field("issue", "title") or "PR Review"
    body = _event_field("pull_request", "body") or _event_field("issue", "body") or ""
    base_ref, head_ref, git_diff, changed_files = _extract_git_context()
    max_diff = int(CONFIG.get("maxDiffChars", 120000))
    if len(git_diff) > max_diff:
        git_diff = git_diff[:max_diff] + "\n\n[diff truncated for model context]\n"
    git_diff = _redact_secrets(git_diff)
    body = _redact_secrets(str(body))
    sensitive = orchestrator.classify_sensitive_files(changed_files)
    media_context, _labels = orchestrator.enrich_with_media_ocr(
        title=str(title), body=str(body), changed_files=changed_files)
    return ReviewContext(title=str(title), body=str(body), git_diff=git_diff,
                         changed_files=changed_files, base_ref=base_ref, head_ref=head_ref,
                         sensitive_files=sensitive, media_context=media_context)


def _extract_git_context() -> tuple[str, str, str, list[str]]:
    base_sha = os.environ.get("PR_BASE_SHA", "")
    head_sha = os.environ.get("PR_HEAD_SHA", "")
    if not base_sha or not head_sha:
        # workflow_dispatch fallback: diff against default branch.
        try:
            base_sha = subprocess.run(["git", "merge-base", "HEAD", "origin/main"],
                                      capture_output=True, text=True, timeout=30).stdout.strip()
            head_sha = subprocess.run(["git", "rev-parse", "HEAD"],
                                      capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:
            return "", "", "", []
    if not base_sha or not head_sha:
        return "", "", "", []
    try:
        diff = subprocess.run(["git", "diff", f"{base_sha}...{head_sha}"],
                              capture_output=True, text=True, timeout=60).stdout
        names = subprocess.run(["git", "diff", "--name-only", f"{base_sha}...{head_sha}"],
                               capture_output=True, text=True, timeout=60).stdout.splitlines()
        return base_sha[:12], head_sha[:12], diff, [n for n in names if n]
    except Exception:
        return "", "", "", []


if __name__ == "__main__":
    raise SystemExit(main())
