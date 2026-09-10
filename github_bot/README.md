# OpenCode2API GitHub AI Bot

In-repo advisory bot for:

- **Issue investigation** — quality score, missing-info checklist, root-cause hypotheses, security routing
- **PR code review** — multi-agent gateway-safety / API-compat / docs-config review with aggregate verdict
- **PR explain** — plain-language summary of a pull request
- **Scheduled scan** — deterministic pre-scan + LLM re-check, fingerprint dedupe, auto-open issues (max 3/run)
- **Fix proposal** — fix plan comment always; draft PR only with opt-in and a clean `git apply --check`

Public comments do not disclose model names or provider routing. Session and
response IDs are always echoed for `previous_response_id` chaining.

## Package layout

| Path | Role |
| --- | --- |
| `src/github_runner.py` | Actions entry; modes review/triage/comment/explain/scan/fix-plan; sticky publish |
| `src/agent_orchestrator.py` | Pipelines, quality gates, fail-closed stubs, verdict aggregation |
| `src/llm_client.py` | Gateway + CPA client, xhigh/high mapping, streaming, fallbacks, session meta |
| `src/media_ocr.py` | Media/log discovery + multimodal summaries (non-fatal) |
| `src/repo_scan.py` | Deterministic scan (secret patterns, forbidden files, config-matrix drift) |
| `config/bot_config.json` | Roles, models, triage sections, scan policy, session contract |
| `config/LLM_config.example.json` | Dual-channel template (`${VAR}` only — never commit filled values) |
| `prompts/` | Soul + role prompts |
| `../tests/test_ai_bot.py` | Unit tests (34 tests) |
| `../docs/AI_BOT.md` | Maintainer documentation |
| `../.github/workflows/ai-review.yml` | Review/triage/explain triggers |
| `../.github/workflows/ai-scan.yml` | Weekly scan + auto-issue |
| `../.github/workflows/ai-fix.yml` | `/fix` plan + opt-in draft PR |

## Commands

Default needs no secrets: workflows start their own no-auth localhost gateway.
To use an external gateway or CPA, export names only (never commit values):

```bash
export GATEWAY_BASE_URL='http://127.0.0.1:10000'  # external override; in-job default when unset
export GATEWAY_API_KEY=your-gateway-key-here  # external gateway key; empty = no-auth localhost
export CPA_BASE_URL=your-cpa-url-here     # never commit (fallback channel)
export CPA_API_KEY=your-cpa-key-here      # never commit (fallback channel)
export PYTHONPATH=github_bot/src
python3 github_bot/src/github_runner.py --mode=review --dry-run
python3 github_bot/src/github_runner.py --mode=triage --dry-run
python3 github_bot/src/github_runner.py --mode=scan --dry-run
PYTHONPATH=github_bot/src python3 -m unittest tests.test_ai_bot -v
```

Optional triage dry-run env vars: `ISSUE_TITLE`, `ISSUE_BODY`, `ISSUE_COMMENTS_JSON`.

Do not commit real keys or a `config/LLM_config.json` that embeds secrets
(git-ignored). Prefer `LLM_config.example.json` as a template only.

## Slash commands (GitHub comments)

Slash commands run for collaborators only (`OWNER`/`MEMBER`/`COLLABORATOR`;
abuse/budget gate). Automatic PR/issue events are unaffected.

| Context | Command | Result |
| --- | --- | --- |
| Pull request | `/review` | Multi-agent PR code review |
| Pull request | `/explain` | PR explanation |
| Issue | `/triage` or `/review` | Issue investigation (not PR review) |
| Issue | `/explain` | Routed to issue investigation |
| Issue | `/fix` | Fix plan comment (sticky, updated on rerun); draft PR only with workflow opt-in (write standalone `/fix` — comma-attached forms don't trigger the workflow) |

## Quality posture

- Issue path investigates causes and completeness; it does **not** emit PR merge verdicts
- PR path reviews the provided diff for gateway-safety, API-compat, and docs-config
- Thread-aware triage suppresses questions already asked in the issue thread
- Incomplete or truncated drafts fail closed into a structured stub
- Scan findings carry stable `opencode2api-scan:<slug>:<hash>` fingerprints; reruns update instead of duplicating
- Fix proposals never auto-merge; draft PRs require human review; apply stages only diff-named paths on a unique per-run branch

## Model routing (internal maintainer config only)

- Triage primary: `gemini-3.8-flash-high` (CPA, high)
- Safety primary: `grok-4.6` (CPA, high)
- API-compat primary: `claude-opus-4-6-thinking` (CPA, high)
- Docs primary: `muse-spark-1.3-contributor-free` (gateway, xhigh)
- Explainer primary: `big-pickle` (gateway, high)
- Scanner primary: `grok-composer-2.5-fast` (CPA, high)

Fallbacks cross-cover both channels so the mains back each other up.
These names must never appear in public issue/PR comments.

## Label application

After a successful triage publish, the runner may **add** allowlisted labels
parsed from `SUGGESTED_LABELS`:

- Controlled by `config/bot_config.json` → `triage.applySuggestedLabels` + `triage.labelAllowlist` (+ `suggestOnlyLabels: [security]`)
- Additive only; unknown and suggest-only labels are ignored; failures are non-fatal
- Disabled automatically on `--dry-run` / missing GitHub context
