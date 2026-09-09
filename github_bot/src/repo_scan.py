"""Deterministic repo pre-scan for OpenCode2API scheduled workflow.

Stdlib only. Produces fingerprint-stable findings so reruns update existing
issues instead of opening duplicates. All evidence is redacted/truncated;
secret VALUES never leave this module.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
PREFIX = "opencode2api-scan:"

SECRET_PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private-key-material"),
    # Quoted assignments only. Bare code (`self.api_key = lookup(...)`) and
    # unquoted env lines (`API_KEY= SOME_VAR`) are noise; pasted secrets are
    # almost always quoted. Committed `.env` files are caught separately by
    # is_forbidden_tracked, so recall on real leaks is preserved.
    (r"(?i)(api[_-]?key|apikey)\s*[:=]\s*['\"][^'\"]{3,}['\"]", "possible-api-key"),
    (r"(?i)(password|passwd)\s*[:=]\s*['\"][^'\"]{3,}['\"]", "possible-password"),
]
SEVERITY_RANK = {"blocking": 0, "should-fix": 1, "nit": 2}

# Secret-pattern hits under these paths are overwhelmingly fixtures/docs, not
# leaks. Downgraded to nit so real findings sort first; fingerprints stay
# stable so reruns still dedupe.
LOW_RISK_DIRS = ("tests/", "docs/")
LOW_RISK_SUFFIXES = (".yml", ".yaml", ".md")


def is_low_risk_path(rel: str) -> bool:
    """True for fixture/doc/config paths where quoted hits are usually noise."""
    return rel.startswith(LOW_RISK_DIRS) or rel.endswith(LOW_RISK_SUFFIXES)

# Exact tracked paths that must never be committed (values, not templates).
# Note: `.env.example` is an intentionally tracked template and must NOT match.
FORBIDDEN_TRACKED = (".env", "config.json", "opencode.json")


def is_forbidden_tracked(rel: str) -> bool:
    """True only for real secret files; never for `*.example` templates."""
    if rel in FORBIDDEN_TRACKED:
        return True
    if rel == ".env" or (rel.startswith(".env.") and not rel.endswith(".example")):
        return True
    return False
MATRIX_FILES = [
    ".env.example",
    "config.json.example",
    "Dockerfile",
    "docker-compose.yml",
    "index.ts",
    "docs/configuration.md",
]


def fingerprint(slug: str, path: str) -> str:
    """Stable fingerprint: prefix + slug + 8-hex path hash."""
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:8]
    return f"{PREFIX}{slug}:{digest}"


def _finding(
    slug: str, path: str, severity: str, evidence: str, line: int | str = 1,
) -> dict[str, str]:
    return {
        "fingerprint": fingerprint(slug, path),
        "severity": severity,
        "location": f"{path}:{line}",
        "evidence": evidence[:300],
    }


def scan_worktree(max_files: int = 400) -> list[dict[str, str]]:
    """Scan tracked text files for secret patterns + forbidden names."""
    findings: list[dict[str, str]] = []
    try:
        import subprocess

        out = subprocess.run(
            ["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, timeout=30,
        )
        tracked = out.stdout.splitlines() if out.returncode == 0 else []
    except Exception:
        tracked = []
    skip_dirs = ("node_modules/", "dist/", "coverage/", ".git/")
    checked = 0
    for rel in tracked:
        if any(rel.startswith(d) for d in skip_dirs):
            continue
        if is_forbidden_tracked(rel):
            findings.append(_finding("forbidden-file-tracked", rel, "blocking",
                                     f"tracked path {rel} must not be committed"))
            continue
        if rel.endswith(".example"):
            # Tracked templates (`.env.example`, `config.json.example`) carry
            # placeholder values by design; secret-pattern hits there are noise.
            continue
        path = REPO_ROOT / rel
        if not path.is_file() or path.stat().st_size > 300_000:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="strict")
        except Exception:
            continue
        if checked >= max_files:
            sys.stderr.write(
                f"[scan] file budget exhausted ({max_files}); "
                "remaining tracked files skipped\n"
            )
            break
        checked += 1
        # One finding per (rule, file): fingerprints differ by slug so coexisting
        # rules on the same file each get their own stable id.
        reported_rules: set[str] = set()
        low_risk = is_low_risk_path(rel)
        for i, line in enumerate(text.splitlines(), 1):
            for pattern, rule in SECRET_PATTERNS:
                if rule not in reported_rules and re.search(pattern, line):
                    severity = "nit" if low_risk else "blocking"
                    findings.append(_finding(rule, rel, severity, "[REDACTED line]", i))
                    reported_rules.add(rule)
    findings.sort(key=lambda d: (SEVERITY_RANK.get(d["severity"], 9), d["fingerprint"]))
    return findings


def scan_config_matrix() -> list[dict[str, str]]:
    """Check that OPENCODE_* canonical names stay in sync across matrix files."""
    findings: list[dict[str, str]] = []
    try:
        env_example = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
    except Exception:
        return findings
    names = set(re.findall(r"^(OPENCODE_[A-Z0-9_]+|API_KEY|PORT|BIND_HOST)\s*=", env_example, flags=re.M))
    for rel in MATRIX_FILES[1:]:
        try:
            text = (REPO_ROOT / rel).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        missing = [n for n in sorted(names) if n not in text and n not in {"API_KEY", "PORT", "BIND_HOST"}]
        # Only flag when the file should mention the matrix (docker/index/docs).
        # Any missing set is reported so drift cannot accumulate invisibly;
        # severity scales with the size of the gap.
        if rel in {"Dockerfile", "docker-compose.yml", "index.ts", "docs/configuration.md"} and missing:
            sample = ",".join(missing[:3])
            severity = "should-fix" if len(missing) >= 5 else "nit"
            findings.append(_finding("config-matrix-drift", rel, severity,
                                     f"{len(missing)} canonical names absent, e.g. {sample}"))
    return findings


def collect_findings(max_files: int = 400) -> list[dict[str, str]]:
    """All deterministic findings, de-duplicated by fingerprint."""
    seen: dict[str, dict[str, str]] = {}
    for item in scan_worktree(max_files) + scan_config_matrix():
        seen.setdefault(item["fingerprint"], item)
    return list(seen.values())


def main() -> int:
    """CLI: print findings JSON (used by workflow + dry-run)."""
    findings = collect_findings()
    print(json.dumps(findings, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
