# AI Bot (GitHub Actions)

In-repo advisory bot for OpenCode2API: issue investigation, multi-agent PR
review, PR explanations, scheduled repo scans with auto-issue, and fix-plan
proposals with opt-in draft PRs.

Public issue/PR comments never disclose model names or provider routing, but
always echo session/response IDs so runs can chain via `previous_response_id`.

## Workflows

| Workflow | Triggers | Permissions | Behavior |
| --- | --- | --- | --- |
| `ai-review.yml` | PR opened/reopened/synchronize/ready_for_review, issues opened, `/review` `/triage` `/explain` comments, manual dispatch | `contents:read`, `pull-requests:write`, `issues:write` | Sticky-marker review/triage/explain; automatic triggers skip draft PRs (an explicit `/review` comment still runs) |
| `ai-scan.yml` | Weekly cron (Mon 02:00 UTC), manual dispatch | `contents:read`, `issues:write` | Deterministic pre-scan + LLM re-check; fingerprint dedupe; max 3 new issues/run (manual `max_issues` is clamped to the same cap) |
| `ai-fix.yml` | `/fix` comments (collaborators only), manual dispatch | `contents:write`, `pull-requests:write`, `issues:write` | Fix plan comment always (sticky, updated on rerun); draft PR only with opt-in AND a clean `git apply --check`, staging only diff-named paths on a unique per-run branch. `maxPrsPerRun: 1` is enforced by single-issue runs + the workflow concurrency group (one active fix run per issue), not by a PR counter. |

## Secrets (names only — never commit values)

No secrets are required for the default setup. Each workflow starts its own
no-auth localhost gateway (`API_KEY` empty = no auth on the ephemeral runner,
`OPENCODE_PROXY_MANAGE_BACKEND=true` so it spawns its own backend with
anonymous out-of-box free quota). Optional overrides:

| Secret | Purpose |
| --- | --- |
| `GATEWAY_BASE_URL` | External gateway URL. When set, the in-job gateway is skipped. When unset, defaults to `http://127.0.0.1:10000`. |
| `GATEWAY_API_KEY` | Key for an external gateway (sent as `Bearer`; omitted when empty). |
| `OPENCODE_API_KEY` | Legacy alias accepted as gateway key when `GATEWAY_API_KEY` is unset. |
| `CPA_BASE_URL` / `CPA_API_KEY` | CPA Responses channel (fallback). Without these the bot runs gateway-only and logs a warning. |

Upstream Zen blocks APIKEY-direct free-model calls, so the bot never calls
Zen directly: free models go through an opencode2api gateway (its credentials
are auto-generated on first start — no login needed, out-of-box anonymous
free quota), CPA models go through `CPA_BASE_URL`. The gateway can be a
long-lived host or spun up ephemerally inside the workflow job pointing at
`127.0.0.1:10000`.

## Model routing (maintainer config — never in public comments)

All roles walk the same global `fallbackModels` chain (`bot_config.json`);
each call tries its primary first, then the global chain minus the primary, so
the three mains back each other up on every path. Thinking: gateway accepts
`xhigh` natively, CPA maps `xhigh→high`.

| Role (trigger) | Primary (channel / thinking) | Effective order (primary → global chain) |
| --- | --- | --- |
| triage / issue | CPA `gemini-3.8-flash-high` / high | `gemini-3.8-flash-high` → `grok-4.6` → `muse-spark-1.3-contributor-free` → `claude-opus-4-6-thinking` → …full chain |
| gateway_safety (review) | CPA `grok-4.6` / high | `grok-4.6` → `gemini-3.8-flash-high` → `muse-spark-1.3-contributor-free` → `claude-opus-4-6-thinking` → …full chain |
| api_compat (review) | CPA `claude-opus-4-6-thinking` / high | `claude-opus-4-6-thinking` → `gemini-3.8-flash-high` → `grok-4.6` → `muse-spark-1.3-contributor-free` → …full chain |
| docs_config (review) | gateway `muse-spark-1.3-contributor-free` / xhigh | `muse-spark-1.3-contributor-free` → `gemini-3.8-flash-high` → `grok-4.6` → `claude-opus-4-6-thinking` → …full chain |
| explainer (`/explain`) | gateway `big-pickle` / high | `big-pickle` → `gemini-3.8-flash-high` → `grok-4.6` → `muse-spark-1.3-contributor-free` → …full chain |
| scanner (scheduled) | CPA `grok-composer-2.5-fast` / high | `grok-composer-2.5-fast` → `gemini-3.8-flash-high` → `grok-4.6` → `muse-spark-1.3-contributor-free` → …full chain |
| media_ocr | CPA `gemini-3.8-flash-high` / high | `gemini-3.8-flash-high` → `grok-4.6` → `muse-spark-1.3-contributor-free` → …full chain |

Role primaries are maximally separated; the three mains
(`gemini-3.8-flash-high`, `grok-4.6`, `muse-spark-1.3-contributor-free`) back
each other up in every fallback chain. Thinking: gateway accepts `xhigh`
(native), CPA maps `xhigh→high`.

## Session / thinking contract

- History blocks (`signature`, `encrypted_content`, `redacted_thinking`) are
  forwarded verbatim and never stripped or forged.
- Every run echoes `[session] role=… response_id=…` on stdout and a
  `Session: response_id=… (chain via previous_response_id, 30min TTL)` footer
  in created issues/comments.
- Gateway-generated reasoning has empty signatures by design; forwarded
  history thinking keeps its original signature.

## Labels

Triage may add allowlisted labels only
(`bug`, `documentation`, `enhancement`, `question`, `needs-info`,
`needs-triage`, `api-compat`, `config`, `tool-safety`, `support`,
`duplicate`, `invalid`, `wontfix`, `good first issue`, `help wanted`).
`security` is suggest-only (never auto-applied). Failures are non-fatal.

## Local dry-run (placeholder values only)

Point at a local gateway (start one with `API_KEY= OPENCODE_PROXY_MANAGE_BACKEND=true node dist/index.js`)
or fill placeholders — never commit real values:

```bash
export GATEWAY_BASE_URL='http://127.0.0.1:10000' GATEWAY_API_KEY='' CPA_BASE_URL=your-cpa-url-here CPA_API_KEY=your-cpa-key-here
export PYTHONPATH=github_bot/src
python3 github_bot/src/github_runner.py --mode=review --dry-run
python3 github_bot/src/github_runner.py --mode=triage --dry-run
python3 github_bot/src/github_runner.py --mode=scan --dry-run
PYTHONPATH=github_bot/src python3 -m unittest tests.test_ai_bot -v
```

Never commit a filled-in `github_bot/config/LLM_config.json` (git-ignored);
only `LLM_config.example.json` is tracked.
