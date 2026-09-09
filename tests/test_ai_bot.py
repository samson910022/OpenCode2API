"""Unit tests for OpenCode2API GitHub AI bot (stdlib + unittest only).

Run: PYTHONPATH=github_bot/src python3 -m unittest tests.test_ai_bot -v
"""

import json
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BOT_DIR = REPO_ROOT / "github_bot"
sys.path.insert(0, str(BOT_DIR / "src"))

from agent_orchestrator import (  # noqa: E402
    AgentOrchestrator,
    ReviewContext,
    is_triage_report_publishable,
    scrub_internal_names,
    validate_triage_report,
)
from llm_client import (  # noqa: E402
    LLMClient,
    VALID_REASONING_EFFORTS,
    _extract_response_id,
    _redact_secrets,
    normalize_effort_for_provider,
)
from repo_scan import fingerprint  # noqa: E402
import github_runner  # noqa: E402


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class TestBotConfig(unittest.TestCase):
    def setUp(self):
        self.bot = load_json(BOT_DIR / "config" / "bot_config.json")
        self.llm = load_json(BOT_DIR / "config" / "LLM_config.example.json")

    def test_markers_unique(self):
        markers = [self.bot["commentMarker"], self.bot["triageMarker"],
                   self.bot["commandMarker"], self.bot["scanMarker"]]
        self.assertEqual(len(set(markers)), 4)
        for marker in markers:
            self.assertIn("OPENCODE2API_AI_", marker)

    def test_default_branch_main(self):
        self.assertIn("main", self.bot["defaultBranchCandidates"])

    def test_role_primaries_separated_and_catalogued(self):
        roles = self.bot["roles"]
        primaries = [roles[r]["model"] for r in roles]
        self.assertEqual(len(set(primaries)), len(roles))
        catalog = {m["id"] for p in self.llm.values() for m in p.get("models", [])}
        for model in primaries:
            self.assertIn(model, catalog, f"role primary {model} missing from LLM catalog")

    def test_mains_mutually_fallback(self):
        chain = self.bot["fallbackModels"]
        for main in ("gemini-3.8-flash-high", "grok-4.6", "muse-spark-1.3-contributor-free"):
            self.assertIn(main, chain)

    def test_thinking_levels_valid(self):
        for provider in self.llm.values():
            for model in provider.get("models", []):
                effort = model.get("reasoningEffort")
                if effort:
                    self.assertIn(str(effort).lower(), VALID_REASONING_EFFORTS)

    def test_triage_contract(self):
        triage = self.bot["triage"]
        self.assertIn("CLASSIFICATION", triage["requiredSections"])
        self.assertIn("ISSUE_QUALITY_SCORE", triage["requiredSections"])
        self.assertNotIn("security", triage["labelAllowlist"])
        self.assertIn("security", triage.get("suggestOnlyLabels", []))

    def test_scan_safety(self):
        scan = self.bot["scan"]
        self.assertTrue(scan["autoFix"]["draftPrOnly"])
        self.assertTrue(scan["autoFix"]["requireHumanReview"])
        self.assertLessEqual(int(scan["maxIssuesPerRun"]), 5)

    def test_session_handling_flags(self):
        session = self.bot["sessionHandling"]
        self.assertTrue(session["preserveThinkingSignatures"])
        self.assertTrue(session["returnResponseIds"])

    def test_prompt_files_exist(self):
        for role, cfg in self.bot["roles"].items():
            path = BOT_DIR / cfg["promptFile"].lstrip("./")
            self.assertTrue(path.is_file(), f"missing prompt for {role}: {path}")
        self.assertTrue((BOT_DIR / "prompts" / "SOUL.md").is_file())

    def test_no_secrets_in_example(self):
        raw = (BOT_DIR / "config" / "LLM_config.example.json").read_text(encoding="utf-8")
        self.assertNotIn("sk-", raw)
        self.assertIn("${GATEWAY_API_KEY}", raw)
        self.assertIn("${CPA_API_KEY}", raw)
        self.assertIn("${CPA_BASE_URL}", raw)

    def test_scan_ignores_env_example(self):
        from repo_scan import is_forbidden_tracked
        self.assertFalse(is_forbidden_tracked(".env.example"))
        self.assertTrue(is_forbidden_tracked(".env"))
        self.assertTrue(is_forbidden_tracked(".env.local"))
        self.assertTrue(is_forbidden_tracked("config.json"))

    def test_scrub_covers_full_catalog(self):
        from llm_client import INTERNAL_MODEL_NAMES
        catalog = {m["id"] for p in self.llm.values() for m in p.get("models", [])}
        for mid in catalog:
            self.assertIn(mid, set(INTERNAL_MODEL_NAMES), f"scrub list missing {mid}")
            self.assertNotIn(mid, scrub_internal_names(f"uses {mid} today"))


class TestLLMClient(unittest.TestCase):
    def test_xhigh_valid_and_cpa_normalized(self):
        self.assertIn("xhigh", VALID_REASONING_EFFORTS)
        self.assertEqual(normalize_effort_for_provider("xhigh", "responses"), "high")
        self.assertEqual(
            normalize_effort_for_provider("xhigh", "openai-completions", "https://x/responses"), "high")
        self.assertEqual(
            normalize_effort_for_provider("xhigh", "openai-completions", "http://127.0.0.1:10000/v1/"),
            "xhigh")

    def test_response_id_keys(self):
        self.assertEqual(_extract_response_id({"id": "a"}), "a")
        self.assertEqual(_extract_response_id({"response_id": "b"}), "b")
        self.assertEqual(_extract_response_id({"response": {"id": "c"}}), "c")

    def test_redact_and_sanitize(self):
        self.assertIn("[REDACTED]", _redact_secrets("api_key=supersecret123"))
        self.assertIn("[REDACTED]", _redact_secrets("Authorization: Bearer abc.def.ghi"))
        from llm_client import sanitize_public_error_text
        safe = sanitize_public_error_text("model gemini-3.8-flash-high provider cpa CPA_API_KEY bad")
        self.assertNotIn("gemini-3.8", safe)
        self.assertNotIn("CPA_API_KEY", safe)

    def test_thinking_passthrough(self):
        from llm_client import _prepare_messages_for_model
        messages = [{"role": "user",
                     "content": [{"type": "text", "text": "hi"}],
                     "signature": "sig123",
                     "encrypted_content": "enc456"}]
        model_info = {"input": ["text", "image"]}
        prepared = _prepare_messages_for_model(messages, model_info)
        self.assertEqual(prepared[0]["signature"], "sig123")
        self.assertEqual(prepared[0]["encrypted_content"], "enc456")

    def test_gateway_base_normalized_to_v1(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ,
                             {"CI": "true", "GATEWAY_BASE_URL": "http://127.0.0.1:10000"},
                             clear=False):
            for k in ("GATEWAY_API_KEY", "OPENCODE_API_KEY", "CPA_API_KEY", "CPA_BASE_URL"):
                os.environ.pop(k, None)
            client = LLMClient()
            self.assertEqual(client.providers["gateway"]["baseUrl"],
                             "http://127.0.0.1:10000/v1/")
            captured = {}

            def fake_post(endpoint, body, headers, timeout, api_type,
                          min_chars, required_markers, **kwargs):
                captured["endpoint"] = endpoint
                return ("hi", {})

            client._post_and_parse = fake_post
            client.chat_completion_with_meta(
                "big-pickle", [{"role": "user", "content": "hi"}], allow_fallback=False)
            self.assertEqual(captured["endpoint"],
                             "http://127.0.0.1:10000/v1/chat/completions")

    def test_gateway_base_with_v1_untouched(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ,
                             {"CI": "true",
                              "GATEWAY_BASE_URL": "http://127.0.0.1:10000/v1/"},
                             clear=False):
            for k in ("GATEWAY_API_KEY", "OPENCODE_API_KEY", "CPA_API_KEY", "CPA_BASE_URL"):
                os.environ.pop(k, None)
            client = LLMClient()
            self.assertEqual(client.providers["gateway"]["baseUrl"],
                             "http://127.0.0.1:10000/v1/")

    def test_model_allowlist_slash_form(self):
        from llm_client import MODEL_ID_ALLOWLIST
        self.assertTrue(MODEL_ID_ALLOWLIST.fullmatch("opencode/big-pickle"))
        self.assertTrue(MODEL_ID_ALLOWLIST.fullmatch("big-pickle"))
        self.assertFalse(MODEL_ID_ALLOWLIST.fullmatch("a/b/c"))
        self.assertFalse(MODEL_ID_ALLOWLIST.fullmatch("../x"))

    def test_noauth_gateway_usable_without_any_key(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ,
                             {"CI": "true", "GATEWAY_BASE_URL": "http://127.0.0.1:10000/"},
                             clear=False):
            for k in ("GATEWAY_API_KEY", "OPENCODE_API_KEY", "CPA_API_KEY", "CPA_BASE_URL"):
                os.environ.pop(k, None)
            client = LLMClient()
            # Gateway needs only a base URL: stays default, no switch to CPA.
            self.assertEqual(client.default_provider, "gateway")

            def fake_single(model_id, messages, **kwargs):
                return ("hello", {"endpoint": "test"})

            client._single_call = fake_single
            text, meta = client.chat_completion_with_meta(
                "big-pickle", [{"role": "user", "content": "hi"}], allow_fallback=False)
            self.assertEqual(text, "hello")
            self.assertEqual(meta["provider"], "gateway")

    def test_noauth_gateway_omits_auth_header(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ,
                             {"CI": "true", "GATEWAY_BASE_URL": "http://127.0.0.1:10000/"},
                             clear=False):
            for k in ("GATEWAY_API_KEY", "OPENCODE_API_KEY", "CPA_API_KEY", "CPA_BASE_URL"):
                os.environ.pop(k, None)
            client = LLMClient()
            captured = {}

            def fake_post(endpoint, body, headers, timeout, api_type,
                          min_chars, required_markers, **kwargs):
                captured["headers"] = headers
                return ("hi", {})

            client._post_and_parse = fake_post
            client.chat_completion_with_meta(
                "big-pickle", [{"role": "user", "content": "hi"}], allow_fallback=False)
            self.assertNotIn("Authorization", captured["headers"])

    def test_client_loads_dual_channel(self):
        client = LLMClient()
        self.assertIn("gateway", client.providers)
        self.assertIn("cpa", client.providers)
        self.assertIn("muse-spark-1.3-contributor-free", client.models)
        self.assertIn("gemini-3.8-flash-high", client.models)


class TestOrchestrator(unittest.TestCase):
    def test_validate_triage(self):
        required = ["CLASSIFICATION", "ACTIONABILITY", "SUMMARY", "ISSUE_QUALITY_SCORE"]
        good = ("CLASSIFICATION\n- bug\n\nACTIONABILITY\n- actionable\n\n"
                "SUMMARY\n- " + "x" * 400 + "\n\nISSUE_QUALITY_SCORE: 85 (actionable)\n")
        ok, missing = validate_triage_report(good, required)
        self.assertTrue(ok, missing)
        ok2, missing2 = validate_triage_report("too short", required)
        self.assertFalse(ok2)
        self.assertTrue(is_triage_report_publishable(good, required))

    def test_sensitive_globs(self):
        orch = AgentOrchestrator.__new__(AgentOrchestrator)
        orch.config = load_json(BOT_DIR / "config" / "bot_config.json")
        hits = AgentOrchestrator.classify_sensitive_files(orch, ["src/proxy.ts", "README.md", ".env"])
        self.assertIn("src/proxy.ts", hits)
        self.assertIn(".env", hits)
        self.assertNotIn("README.md", hits)

    def test_deterministic_redaction(self):
        orch = AgentOrchestrator.__new__(AgentOrchestrator)
        orch.config = load_json(BOT_DIR / "config" / "bot_config.json")
        findings = AgentOrchestrator.deterministic_findings(
            orch, '+ api_key = "supersecret"\n+ normal line\n', ["src/a.ts"])
        self.assertTrue(findings)
        self.assertNotIn("supersecret", json.dumps(findings))

    def test_scrub_names(self):
        scrubbed = scrub_internal_names("uses gemini-3.8-flash-high via cpa")
        self.assertNotIn("gemini-3.8", scrubbed)

    def test_fail_closed_stub_sections(self):
        orch = AgentOrchestrator.__new__(AgentOrchestrator)
        orch.config = load_json(BOT_DIR / "config" / "bot_config.json")
        stub = AgentOrchestrator.build_fail_closed_triage_stub(orch, "t", "partial")
        for section in load_json(BOT_DIR / "config" / "bot_config.json")["triage"]["requiredSections"]:
            self.assertIn(section, stub)

    def test_verdict_aggregation_verdict_line_only(self):
        orch = AgentOrchestrator.__new__(AgentOrchestrator)
        orch.config = load_json(BOT_DIR / "config" / "bot_config.json")
        ctx = AgentOrchestrator.__new__(AgentOrchestrator)
        review_ctx = ReviewContext(title="t", body="b")
        # Prose mention of NEEDS_CHANGES must not flip an APPROVE verdict.
        orch._run_role = lambda role, prompt, **kw: (
            "VERDICT: APPROVE\nAll good, no NEEDS_CHANGES here.", {"response_id": "r1"})
        report = AgentOrchestrator.run_multi_agent_review(orch, review_ctx)
        self.assertIn("FINAL_VERDICT: APPROVE", report)
        # Missing VERDICT line degrades to COMMENT, not NEEDS_CHANGES.
        orch._run_role = lambda role, prompt, **kw: (
            "Some rambling review without a verdict line.", {"response_id": "r2"})
        report2 = AgentOrchestrator.run_multi_agent_review(orch, review_ctx)
        self.assertIn("FINAL_VERDICT: COMMENT", report2)
        self.assertNotIn("FINAL_VERDICT: NEEDS_CHANGES", report2)
        # A real NEEDS_CHANGES verdict still wins.
        def mixed(role, prompt, **kw):
            if role == "api_compat":
                return ("VERDICT: NEEDS_CHANGES\nBLOCKING:\n- x", {"response_id": "r3"})
            return ("VERDICT: APPROVE\nFine.", {"response_id": "r4"})
        orch._run_role = mixed
        report3 = AgentOrchestrator.run_multi_agent_review(orch, review_ctx)
        self.assertIn("FINAL_VERDICT: NEEDS_CHANGES", report3)

    def test_verdict_aggregation_bold_markdown(self):
        # Live models wrap the verdict in bold: **VERDICT: APPROVE**.
        # Bold-italic (***) is tolerated too.
        orch = AgentOrchestrator.__new__(AgentOrchestrator)
        orch.config = load_json(BOT_DIR / "config" / "bot_config.json")
        review_ctx = ReviewContext(title="t", body="b")
        orch._run_role = lambda role, prompt, **kw: (
            "**VERDICT: APPROVE**\n\nAll good.", {"response_id": "r1"})
        report = AgentOrchestrator.run_multi_agent_review(orch, review_ctx)
        self.assertIn("FINAL_VERDICT: APPROVE", report)
        orch._run_role = lambda role, prompt, **kw: (
            "***VERDICT: APPROVE***\n\nAll good.", {"response_id": "r2"})
        report2 = AgentOrchestrator.run_multi_agent_review(orch, review_ctx)
        self.assertIn("FINAL_VERDICT: APPROVE", report2)


class TestScanAndRunner(unittest.TestCase):
    def test_fingerprint_stable(self):
        self.assertEqual(fingerprint("slug", "a/b.ts"), fingerprint("slug", "a/b.ts"))
        self.assertTrue(fingerprint("slug", "a/b.ts").startswith("opencode2api-scan:"))

    def test_comment_modes(self):
        self.assertEqual(github_runner._resolve_comment_mode("/review please"), "review")
        self.assertEqual(github_runner._resolve_comment_mode("/fix this"), "fix-plan")
        self.assertIsNone(github_runner._resolve_comment_mode("hello"))

    def test_runner_redact(self):
        self.assertNotIn("supersecret", github_runner._redact_secrets("token=supersecret"))

    def test_thread_keeps_newest_comments(self):
        import os
        from unittest import mock
        comments = [{"author": f"u{i}", "body": f"question {i}?"} for i in range(35)]
        with mock.patch.dict(os.environ, {"ISSUE_COMMENTS_JSON": json.dumps(comments)},
                             clear=False):
            kept = github_runner._fetch_issue_comments()
        self.assertEqual(len(kept), 30)
        self.assertEqual(kept[0]["body"], "question 5?")
        self.assertEqual(kept[-1]["body"], "question 34?")

    def test_has_llm_route_requires_url(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {}, clear=False):
            for k in ("GATEWAY_BASE_URL", "GATEWAY_API_KEY", "OPENCODE_API_KEY",
                      "CPA_API_KEY", "CPA_BASE_URL"):
                os.environ.pop(k, None)
            self.assertFalse(github_runner._has_llm_route())
            # A bare key without a URL is useless: still no route.
            os.environ["GATEWAY_API_KEY"] = "placeholder"
            self.assertFalse(github_runner._has_llm_route())
            os.environ["GATEWAY_BASE_URL"] = "http://127.0.0.1:10000"
            self.assertTrue(github_runner._has_llm_route())

    def test_diff_paths_parsing_and_containment(self):
        diff = ("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n"
                "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n"
                "diff --git a/x b/../escape\n--- a/x\n+++ b/../escape\n")
        paths = github_runner._diff_paths(diff)
        self.assertEqual(paths, ["src/a.ts"])


if __name__ == "__main__":
    unittest.main()
