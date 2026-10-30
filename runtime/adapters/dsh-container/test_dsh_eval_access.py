"""评测入口同时接受当前免认证 URL 和历史 Token URL。"""

import importlib.util
import io
import hashlib
import os
from importlib.machinery import SourceFileLoader
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import json
import types
import unittest
from unittest import mock
from contextlib import redirect_stderr

spec = importlib.util.spec_from_loader("dsh_eval", SourceFileLoader("dsh_eval", str(Path(__file__).with_name("dsh-eval"))))
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


CHILD = '''
import json,sys
from pathlib import Path
root=Path(__file__).parent
with (root/"calls.jsonl").open("a") as output:
    output.write(json.dumps({"script":Path(__file__).name,"args":sys.argv[1:],"python":sys.executable})+"\\n")
name=Path(__file__).name
if name.startswith("validate"):
    print(json.dumps({"valid":True,"errors":[]}))
elif name=="run_record.py":
    if sys.argv[3]=="init": print("run-11111111-1111-4111-8111-111111111111")
    elif sys.argv[3]=="record": json.loads(sys.stdin.read())
elif sys.argv[1]=="up":
    image="sha256:"+"1"*64
    print(json.dumps({"image_tag":"fixture","image_id":image,"image_ref":"fixture@"+image,"image_build_fingerprint":image,"platform":"fixture"}))
elif sys.argv[1]=="url": print("http://127.0.0.1:3081/?token=fixture-only")
'''


class EvaluationAccessTest(unittest.TestCase):
    def test_preflight_error_keeps_variant_identity_in_result(self):
        identity = "VAR-example-agent-001-r0123456789ab"
        for source in (identity, "experiment:" + identity):
            with self.subTest(source=source), mock.patch.object(sys, "argv", ["dsh-eval", "--source", source]), \
                    mock.patch.object(evaluation, "execute", side_effect=evaluation.EvaluationError("synthetic")), \
                    mock.patch.object(evaluation, "emit_result") as emit, redirect_stderr(io.StringIO()), \
                    self.assertRaises(SystemExit) as stopped:
                evaluation.main()
            self.assertEqual(stopped.exception.code, 2)
            self.assertEqual(emit.call_args.args[0], identity)

    def setUp(self):
        self.environment_patch = mock.patch.dict(os.environ, {})
        self.environment_patch.start()
        self.addCleanup(self.environment_patch.stop)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "config").mkdir()
        (self.root / "config/sites.json").write_text(json.dumps({"platform": "/hep/", "assistant": "/assistant/"}))
        self.repo_patch = mock.patch.object(evaluation, "REPO", self.root)
        self.repo_patch.start()

    def tearDown(self):
        self.repo_patch.stop()
        self.temporary.cleanup()

    def test_external_workspace_site_configuration_is_used(self):
        (self.root / "config/sites.json").write_text(json.dumps({"platform": "/platform/", "assistant": "/custom-agent/"}))
        url = "http://127.0.0.1:3081/custom-agent/"
        with mock.patch.object(evaluation, "checked_process", return_value=subprocess.CompletedProcess([], 0, url, "")):
            self.assertEqual(evaluation.authentication_url("probe"), url)

    def test_local_plain_and_legacy_token_urls_are_accepted(self):
        for url in ("http://127.0.0.1:3081/", "http://127.0.0.1:3081/?token=test-only",
                    "http://127.0.0.1:3081/assistant/", "http://127.0.0.1:3081/assistant/?token=test-only"):
            with self.subTest(url=url), mock.patch.object(evaluation, "checked_process", return_value=subprocess.CompletedProcess([], 0, url + "\n", "")):
                self.assertEqual(evaluation.authentication_url("probe"), url)

    def test_malformed_external_and_credential_urls_are_rejected(self):
        for url in ("http://127.0.0.1.evil:3081/", "http://example.org:3081/", "https://127.0.0.1:3081/", "http://127.0.0.1/", "http://user:pass@127.0.0.1:3081/", "http://127.0.0.1:0/", "http://127.0.0.1:65536/", "http://127.0.0.1:3081/api/", "http://127.0.0.1:3081/assistant",
                    "http://127.0.0.1:3081/assistant/api/", "http://127.0.0.1:3081/#fragment"):
            with self.subTest(url=url), mock.patch.object(evaluation, "checked_process", return_value=subprocess.CompletedProcess([], 0, url, "")):
                with self.assertRaises(evaluation.EvaluationError):
                    evaluation.authentication_url("probe")


class ReviewTargetRouteTest(unittest.TestCase):
    MIMO = {"provider": "xiaomi-token-plan-cn", "model": "mimo-v2.6-flash", "reasoningEffort": "off"}
    QWEN = {"provider": "local-qwen", "model": "Qwen3.5-2B"}
    LOCAL = [
        {"provider": "security-operation-delivery", "model": "fixed-operation-result"},
        {"provider": "threat-analysis-delivery", "model": "fixed-summary"},
        {"provider": "threat-analysis-automation", "model": "scheduled-batch"},
        {"provider": "harness-code-only", "model": "workflow-v1"},
        {"provider": "harness-workflow", "model": "hybrid-v1"},
    ]

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def write_case(self, name="U-FIRST", *, routes=None, final_route=None, extra=None):
        case = {"case_id": name}
        directory = self.root / "evidence" / name
        directory.mkdir(parents=True, exist_ok=True)
        response = {"session_id": "session-root", "turns": [{"route": final_route or self.MIMO}]}
        (directory / "response.json").write_text(json.dumps({"response": response}))
        events = [{"type": "session", "version": 4, "id": "session-root", "delegationDepth": 0}]
        for index, route in enumerate(routes if routes is not None else [self.MIMO], 1):
            events.extend([
                {"type": "request/header", "seq": index * 2, "data": {"header": {"config": route}}},
                {"type": "assistant/message", "seq": index * 2 + 1, "data": {"turn": 1, "step": index}},
            ])
        trace = [{"session_log": "session.v4.jsonl", "event": event} for event in events]
        trace.extend(extra or [])
        (directory / "trace.jsonl").write_text("".join(json.dumps(row) + "\n" for row in trace))
        return case

    def lock_local_routes(self, content=None):
        content = content if content is not None else json.dumps({"runtime_capabilities": {"local_model_routes": self.LOCAL}})
        digest = hashlib.sha256(content.encode()).hexdigest()
        (self.root / "inputs.lock.json").write_text(json.dumps({"harness_trees": {"managed": {"files": [
            {"path": "role-tool-matrix.yaml", "sha256": digest, "size": len(content.encode())},
        ]}}}))
        directory = self.root / "evidence" / "analysis"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "harness.json").write_text(json.dumps({"files": [
            {"tree": "managed", "path": "role-tool-matrix.yaml", "sha256": digest, "content": content},
        ]}))

    def test_root_native_requests_preserve_mimo_despite_each_local_final_adapter(self):
        import scenario_analysis
        self.lock_local_routes()
        for index, local in enumerate(self.LOCAL):
            with self.subTest(local=local):
                case = self.write_case(str(index), routes=[self.MIMO, self.MIMO, local], final_route=local)
                self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.MIMO)

    def test_real_root_mixed_external_models_fail_even_when_final_reply_uses_mimo(self):
        import scenario_analysis
        self.lock_local_routes()
        case = self.write_case(routes=[self.MIMO, self.QWEN, self.LOCAL[0]])
        with self.assertRaisesRegex(ValueError, "target-route-mixed"):
            scenario_analysis._target_route(self.root, [case])

    def test_unknown_provider_and_external_route_without_usage_are_not_treated_as_local(self):
        import scenario_analysis
        self.lock_local_routes()
        case = self.write_case(routes=[self.QWEN])
        self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.QWEN)
        case = self.write_case(routes=[self.MIMO, {"provider": "security-operation-delivery", "model": "unknown-model"}])
        with self.assertRaisesRegex(ValueError, "target-route-mixed"):
            scenario_analysis._target_route(self.root, [case])

    def test_registered_proxy_with_actual_invocation_is_a_review_candidate(self):
        import scenario_analysis
        self.lock_local_routes(json.dumps({"runtime_capabilities": {"local_model_routes": [*self.LOCAL, self.QWEN]}}))
        for evidence in ({"model_invocation": True},
                         {"usage": {"inputTokens": 659, "outputTokens": 17, "totalTokens": 676}},
                         {"usage": {"inputTokens": 470, "outputTokens": 119}},
                         {"usage": {"inputTokens": 1.0, "outputTokens": 0.0}},
                         {"stream": [{"type": "chunk", "chunk": {"type": "usage", "usage": {
                             "inputTokens": 0, "outputTokens": 1, "cacheReadTokens": 4}}}]}):
            with self.subTest(evidence=evidence):
                case = self.write_case(routes=[self.QWEN])
                path = self.root / "evidence" / case["case_id"] / "trace.jsonl"
                trace = [json.loads(line) for line in path.read_text().splitlines()]
                trace[-1]["event"]["data"].update(evidence, message={"role": "assistant", "source": {
                    "kind": "model", **self.QWEN, "replayState": {"response": {"kind": "pi-ai"}}}})
                path.write_text("".join(json.dumps(row) + "\n" for row in trace))
                self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.QWEN)

    def test_registration_zero_or_invalid_usage_does_not_prove_a_review_model(self):
        import scenario_analysis
        self.lock_local_routes(json.dumps({"runtime_capabilities": {"local_model_routes": [self.QWEN]}}))
        for evidence in ({}, {"model_invocation": False},
                         {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}},
                         {"usage": {"inputTokens": True, "outputTokens": 1}},
                         {"usage": {"inputTokens": 1.5, "outputTokens": 1}},
                         {"usage": {"inputTokens": 2 ** 53, "outputTokens": 1}},
                         {"usage": {"inputTokens": -1, "outputTokens": 2}},
                         {"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 4}},
                         {"usage": {"inputTokens": 1, "outputTokens": 2, "reasoningTokens": 3}}):
            with self.subTest(evidence=evidence):
                case = self.write_case(routes=[self.QWEN])
                path = self.root / "evidence" / case["case_id"] / "trace.jsonl"
                trace = [json.loads(line) for line in path.read_text().splitlines()]
                trace[-1]["event"]["data"].update(evidence)
                path.write_text("".join(json.dumps(row) + "\n" for row in trace))
                with self.assertRaisesRegex(ValueError, "target-route-missing"):
                    scenario_analysis._target_route(self.root, [case])

    def test_actual_proxy_and_mimo_in_root_are_mixed_including_unchanged_header(self):
        import scenario_analysis
        self.lock_local_routes(json.dumps({"runtime_capabilities": {"local_model_routes": [self.QWEN]}}))
        for headers in ([self.QWEN, self.MIMO], [self.MIMO, self.MIMO]):
            with self.subTest(headers=headers):
                case = self.write_case(routes=headers)
                path = self.root / "evidence" / case["case_id"] / "trace.jsonl"
                trace = [json.loads(line) for line in path.read_text().splitlines()]
                trace[2]["event"]["data"].update(model_invocation=True, message={"source": {"kind": "model", **self.QWEN}})
                if headers[0] == headers[1]:
                    trace.pop(3)  # 原生 Header 只在配置改变时持久化。
                path.write_text("".join(json.dumps(row) + "\n" for row in trace))
                with self.assertRaisesRegex(ValueError, "target-route-mixed"):
                    scenario_analysis._target_route(self.root, [case])

    def test_settled_source_overrides_header_and_only_matching_identity_keeps_options(self):
        import scenario_analysis
        for header, source, expected in ((self.MIMO, self.QWEN, self.QWEN),
                                         (self.LOCAL[0], self.MIMO, {key: self.MIMO[key] for key in ("provider", "model")}),
                                         (self.MIMO, self.MIMO, self.MIMO)):
            with self.subTest(header=header, source=source):
                self.lock_local_routes()
                case = self.write_case(routes=[header])
                path = self.root / "evidence" / case["case_id"] / "trace.jsonl"
                trace = [json.loads(line) for line in path.read_text().splitlines()]
                trace[-1]["event"]["data"].update(usage={"inputTokens": 4, "outputTokens": 2},
                    message={"source": {"kind": "model", **{key: source[key] for key in ("provider", "model")}}})
                path.write_text("".join(json.dumps(row) + "\n" for row in reversed(trace)))
                self.assertEqual(scenario_analysis._target_route(self.root, [case]), expected)

    def test_invocation_false_conflicting_with_positive_usage_is_not_routable(self):
        import scenario_analysis
        for local in (False, True):
            with self.subTest(local=local):
                if local:
                    self.lock_local_routes(json.dumps({"runtime_capabilities": {"local_model_routes": [self.QWEN]}}))
                case = self.write_case(routes=[self.QWEN])
                path = self.root / "evidence" / case["case_id"] / "trace.jsonl"
                trace = [json.loads(line) for line in path.read_text().splitlines()]
                trace[-1]["event"]["data"].update(model_invocation=False, usage={"inputTokens": 2, "outputTokens": 1})
                path.write_text("".join(json.dumps(row) + "\n" for row in trace))
                with self.assertRaisesRegex(ValueError, "target-route-evidence-conflict"):
                    scenario_analysis._target_route(self.root, [case])

    def test_positive_child_or_graph_does_not_promote_registered_root(self):
        import scenario_analysis
        self.lock_local_routes()
        extra = [
            {"session_log": "subagents/child.jsonl", "event": {"type": "session", "id": "child",
             "parentSession": "session-root", "delegationDepth": 1}},
            {"session_log": "subagents/child.jsonl", "event": {"type": "request/header", "seq": 0,
             "data": {"header": {"config": self.MIMO}}}},
            {"session_log": "subagents/child.jsonl", "event": {"type": "assistant/message", "seq": 1,
             "data": {"model_invocation": True, "usage": {"inputTokens": 20, "outputTokens": 3}}}},
            {"session_log": "session.v4.jsonl", "event": {"type": "tool/result", "seq": 8,
             "data": {"meta": {"graph_execution": {"model_attempts": [{"provider": self.LOCAL[4]["provider"],
                 "model": self.LOCAL[4]["model"], "model_invocation": True,
                 "usage": {"inputTokens": 20, "outputTokens": 3}}]}}}}},
        ]
        case = self.write_case(routes=[self.LOCAL[4]], extra=extra)
        with self.assertRaisesRegex(ValueError, "target-route-missing"):
            scenario_analysis._target_route(self.root, [case])

    def test_failed_or_cancelled_external_request_is_retained_without_assistant_usage(self):
        import scenario_analysis
        case = self.write_case()
        path = self.root / "evidence" / case["case_id"] / "trace.jsonl"
        trace = [json.loads(line) for line in path.read_text().splitlines()]
        for finish in ("error", "aborted"):
            with self.subTest(finish=finish):
                trace[-1]["event"] = {"type": "assistant/attempt", "seq": 3,
                                    "data": {"turn": 1, "step": 1, "finishReason": finish}}
                path.write_text("".join(json.dumps(row) + "\n" for row in trace))
                self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.MIMO)
        (path.parent / "response.json").write_text(json.dumps({"response": None, "error": "case-cancelled"}))
        self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.MIMO)

    def test_native_request_missing_config_fails_instead_of_using_final_response(self):
        import scenario_analysis
        case = self.write_case(routes=[None])
        with self.assertRaisesRegex(ValueError, "target-route-invalid"):
            scenario_analysis._target_route(self.root, [case])

    def test_child_role_model_does_not_replace_root_route_or_supply_missing_root_route(self):
        import scenario_analysis
        self.lock_local_routes()
        child = [
            {"session_log": "subagents/child.jsonl", "event": {"type": "session", "version": 4,
             "id": "session-child", "parentSession": "session-root", "delegationDepth": 1, "agentPreset": "fault-analysis"}},
            {"session_log": "subagents/child.jsonl", "event": {"type": "request/header", "data": {"header": {"config": self.QWEN}}}},
        ]
        case = self.write_case(extra=child)
        self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.MIMO)
        case = self.write_case(routes=[self.LOCAL[4]], extra=child)
        with self.assertRaisesRegex(ValueError, "target-route-missing"):
            scenario_analysis._target_route(self.root, [case])

    def test_pure_local_or_no_request_routes_fail_without_guessing_policy_default(self):
        import scenario_analysis
        self.lock_local_routes()
        for routes in (self.LOCAL, []):
            with self.subTest(routes=routes):
                case = self.write_case(routes=routes)
                with self.assertRaisesRegex(ValueError, "target-route-missing"):
                    scenario_analysis._target_route(self.root, [case])

    def test_trace_root_missing_ambiguous_or_child_identity_never_falls_back_to_response(self):
        import scenario_analysis
        case = self.write_case()
        path = self.root / "evidence" / case["case_id"] / "trace.jsonl"
        trace = [json.loads(line) for line in path.read_text().splitlines()]
        for header in ({"type": "session", "id": "wrong-root"},
                       {"type": "session", "id": "session-root", "parentSession": "parent"},
                       {"type": "session", "id": "session-root", "delegationDepth": 1}):
            with self.subTest(header=header):
                trace[0]["event"] = header
                path.write_text("".join(json.dumps(row) + "\n" for row in trace))
                with self.assertRaisesRegex(ValueError, "target-session-invalid"):
                    scenario_analysis._target_route(self.root, [case])
        trace[0]["event"] = {"type": "session", "id": "session-root"}
        for other in (trace[0],
                      {"session_log": "other.jsonl", "event": {"type": "session", "id": "other-root"}},
                      {"session_log": "session.v4.jsonl", "event": {"type": "session", "id": "other-root",
                       "parentSession": "session-root"}}):
            with self.subTest(other=other):
                path.write_text("".join(json.dumps(row) + "\n" for row in [*trace, other]))
                with self.assertRaisesRegex(ValueError, "target-session-invalid"):
                    scenario_analysis._target_route(self.root, [case])

    def test_frozen_local_declaration_missing_or_modified_fails(self):
        import scenario_analysis
        case = self.write_case()
        self.lock_local_routes()
        path = self.root / "evidence" / "analysis" / "harness.json"
        original = json.loads(path.read_text())
        source = original["files"][0]
        for value in ({"files": []}, {"files": [dict(source, content="{}")]},
                      {"files": [dict(source, content=source["content"].replace("security-operation-delivery", "security-operation-deliverx"))]},
                      {"files": [dict(source, sha256="0" * 64)]}):
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "target-local-routes-(missing|digest-mismatch)"):
                scenario_analysis._target_route(self.root, [case])
        path.unlink()
        with self.assertRaisesRegex(ValueError, "missing-evidence-harness.json"):
            scenario_analysis._target_route(self.root, [case])

    def test_absent_capability_declaration_is_distinct_from_invalid_declaration(self):
        import scenario_analysis
        case = self.write_case()
        self.lock_local_routes("schema_version: '2.0'\n")
        self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.MIMO)
        for capabilities in (None, {}, {"local_model_routes": [self.MIMO]}, {"local_model_routes": [None]}):
            with self.subTest(capabilities=capabilities):
                self.lock_local_routes(json.dumps({"runtime_capabilities": capabilities}))
                with self.assertRaisesRegex(ValueError, "target-local-routes-invalid"):
                    scenario_analysis._target_route(self.root, [case])
        self.lock_local_routes("runtime_capabilities: [\n")
        with self.assertRaisesRegex(ValueError, "target-local-routes-invalid"):
            scenario_analysis._target_route(self.root, [case])

    def test_frozen_declaration_excludes_local_legacy_response_route(self):
        import scenario_analysis
        self.lock_local_routes()
        first = self.write_case(routes=[], final_route=self.LOCAL[0])
        second = self.write_case("U-SECOND")
        for case in (first, second):
            (self.root / "evidence" / case["case_id"] / "trace.jsonl").unlink()
        self.assertEqual(scenario_analysis._target_route(self.root, [first, second]), self.MIMO)

    def test_new_role_snapshot_has_priority_and_preserves_crlf_bytes(self):
        import scenario_analysis
        self.lock_local_routes('# 原始声明\r\nruntime_capabilities:\r\n  local_model_routes:\r\n'
                               '    - provider: security-operation-delivery\r\n      model: fixed-operation-result\r\n')
        case = self.write_case(routes=[self.MIMO, self.LOCAL[0]])
        inputs_path = self.root / "inputs.lock.json"
        inputs = json.loads(inputs_path.read_text())
        inputs["managed_role_snapshot"] = "evidence/managed/role-tool-matrix.yaml"
        inputs_path.write_text(json.dumps(inputs))
        harness = self.root / "evidence/analysis/harness.json"
        content = json.loads(harness.read_text())["files"][0]["content"]
        snapshot = self.root / inputs["managed_role_snapshot"]
        snapshot.parent.mkdir(parents=True)
        snapshot.write_bytes(content.encode())
        harness.write_text("{}")
        self.assertEqual(scenario_analysis._target_route(self.root, [case]), self.MIMO)

    def test_new_role_snapshot_missing_damaged_or_wrong_pointer_cannot_use_legacy_harness(self):
        import scenario_analysis
        self.lock_local_routes()
        case = self.write_case(routes=[self.MIMO, self.LOCAL[0]])
        inputs_path = self.root / "inputs.lock.json"
        inputs = json.loads(inputs_path.read_text())
        original = json.loads((self.root / "evidence/analysis/harness.json").read_text())["files"][0]["content"].encode()
        snapshot = self.root / "evidence/managed/role-tool-matrix.yaml"
        snapshot.parent.mkdir(parents=True)
        for state in ("missing", "damaged", "symlink", "wrong-pointer", "null-pointer", "parent-symlink"):
            with self.subTest(state=state):
                snapshot.unlink(missing_ok=True)
                inputs["managed_role_snapshot"] = "evidence/managed/role-tool-matrix.yaml"
                if state == "damaged":
                    snapshot.write_bytes(original.replace(b"security-operation-delivery", b"security-operation-deliverx"))
                elif state == "symlink":
                    other = self.root / "role-original.yaml"
                    other.write_bytes(original)
                    snapshot.symlink_to(other)
                elif state in {"wrong-pointer", "null-pointer"}:
                    inputs["managed_role_snapshot"] = "other.yaml" if state == "wrong-pointer" else None
                elif state == "parent-symlink":
                    snapshot.write_bytes(original)
                    original_directory = snapshot.parent.with_name("original-managed")
                    snapshot.parent.rename(original_directory)
                    snapshot.parent.symlink_to(original_directory, target_is_directory=True)
                inputs_path.write_text(json.dumps(inputs))
                with self.assertRaisesRegex(ValueError, "target-local-routes-(invalid|missing|digest-mismatch)"):
                    scenario_analysis._target_route(self.root, [case])

    def test_locked_harness_selects_frozen_history_separately_from_current_candidate(self):
        import scenario_analysis
        versions = {}
        for label in ("current", "history"):
            experiment = self.root / label
            contract = {"experiment_root": str(self.root / "current"),
                        "candidate_root": str(experiment / "candidate/dsh")}
            trees = {}
            for tree in ("workspace", "presets", "managed"):
                directory = experiment / "candidate/dsh" / tree
                directory.mkdir(parents=True)
                content = f"{label} {tree}角色原文。\n".encode()
                (directory / "role.md").write_bytes(content)
                contract[tree] = str(directory)
                trees[tree] = {"files": [{"path": "role.md", "size": len(content),
                                          "sha256": hashlib.sha256(content).hexdigest()}]}
            versions[label] = (contract, trees)
        historical_ref = "git:" + "1" * 40

        def resolve(_source, *, repo, source_ref=None):
            self.assertEqual(repo, self.root)
            return versions["history" if source_ref == historical_ref else "current"][0]

        with mock.patch("source_contract.resolve", side_effect=resolve) as lookup:
            for label, ref in (("current", None), ("history", historical_ref)):
                inputs = {"source_id": "experiment:EXP-example-agent-001-r0123456789ab",
                          "harness_trees": versions[label][1],
                          "harness_review": {"schema_version": 1, "generated": [], "sources": []}}
                if ref is not None:
                    inputs["source_ref"] = ref
                result = scenario_analysis._locked_harness(inputs, repo=self.root)
                self.assertEqual(len(result), 3)
                self.assertTrue(all(item["content"].startswith(label + " ") for item in result))
                self.assertEqual({(item["tree"], item["path"], item["sha256"]) for item in result},
                                 {(tree, "role.md", versions[label][1][tree]["files"][0]["sha256"])
                                  for tree in ("workspace", "presets", "managed")})
                self.assertEqual(lookup.call_args.kwargs.get("source_ref"), ref)

    def test_native_provider_routes_are_preserved_and_mixed_or_invalid_routes_fail(self):
        import scenario_analysis
        cases = [{"case_id": "U-FIRST"}, {"case_id": "U-SECOND"}]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def write(route, case):
                target = root / "evidence" / case["case_id"] / "response.json"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps({"response": {"turns": [{"route": route}]}}))
            for provider, model in (("deepseek-official", "deepseek-flash"),
                                    ("xiaomi-token-plan-cn", "mimo-v2.6-flash"),
                                    ("local-qwen", "Qwen3.5-2B")):
                route = {"provider": provider, "model": model, "reasoningEffort": "off"}
                for case in cases:
                    write(route, case)
                self.assertEqual(scenario_analysis._target_route(root, cases), route)
            write({"provider": "xiaomi-token-plan-cn", "model": "mimo-v2.6-pro"}, cases[1])
            with self.assertRaisesRegex(ValueError, "target-route-mixed"):
                scenario_analysis._target_route(root, cases)
            write({"provider": "", "model": "mimo-v2.6-flash"}, cases[0])
            with self.assertRaisesRegex(ValueError, "target-route-invalid"):
                scenario_analysis._target_route(root, cases)


class EvaluationModelPolicyTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.patch(mock.patch.object(evaluation, "REPO", self.root))
        agent = self.root / "agents/example-agent"
        agent.mkdir(parents=True)
        manifest = agent / "manifest.yaml"
        manifest.write_text("agent_id: example-agent\n", encoding="utf-8")
        selected = {"provider": "xiaomi-token-plan-cn", "model": "MiMo-V2.6-Flash", "reasoningEffort": "off"}
        config = self.root / "config"
        config.mkdir()
        default = config / "business-model-default.json"
        default.write_text(json.dumps({"schema_version": "1.2", "default": selected}), encoding="utf-8")
        self.policy = self.root / "policy.json"
        self.policy.write_text(json.dumps({
            "agent_id": "example-agent",
            "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
            "business_model_revision": hashlib.sha256(default.read_bytes()).hexdigest(),
            "allowed": [{"provider": selected["provider"], "model": selected["model"]}],
            "default": selected,
            "credential_refs": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
            "patch": [
                {"id": "agent-default-model", "config": selected},
                {"id": "llm-deepseek", "disabled": True},
                {"id": "llm-deepseek-account", "disabled": True},
                {"id": "llm-pi-ai", "config": {"providers": {"xiaomi-token-plan-cn": {
                    "apiKeyEnv": "XIAOMI_TOKEN_PLAN_CN_API_KEY", "models": [{"id": "MiMo-V2.6-Flash"}],
                }}}},
            ],
        }), encoding="utf-8")
        self.contract = {
            "source_id": "experiment:EXP-example-agent-001", "experiment_id": "EXP-example-agent-001",
            "agent_id": "example-agent", "required_env_names": ["DEEPSEEK_API_KEY", "LOCAL_LLM_BASE_URL", "OPS_MCP_URL"],
            "image": {"local_image_tag": "fixture", "build_fingerprint": "sha256:" + "1" * 64},
        }
        self.cases = [{"case_id": "U-INS-001"}]

    def patch(self, patcher):
        self.addCleanup(patcher.stop)
        return patcher.start()

    def test_dry_run_uses_same_policy_as_real_instance_and_keeps_business_environment(self):
        path = str(self.policy)
        with mock.patch.dict(os.environ, {"XIAOMI_TOKEN_PLAN_CN_API_KEY": "fixture-key"}, clear=True):
            plan = evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none",
                                              path, "MiMo-V2.6-Flash")
        self.assertEqual(plan["required_env_names"], ["OPS_MCP_URL", "XIAOMI_TOKEN_PLAN_CN_API_KEY"])
        self.assertEqual(plan["missing_env_names"], ["OPS_MCP_URL"])
        self.assertNotIn("DEEPSEEK_API_KEY", plan["required_env_names"])
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(evaluation.EvaluationError, "--model-policy"):
            evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none")
        image = "sha256:" + "1" * 64
        reply = subprocess.CompletedProcess([], 0, json.dumps({
            "image_tag": "fixture", "image_id": image, "image_ref": "fixture@" + image,
            "image_build_fingerprint": image, "platform": "fixture",
        }), "")
        with mock.patch.object(evaluation, "checked_process", return_value=reply) as process:
            evaluation.start_instance(self.contract["source_id"], "eval-fixture", path)
        command = process.call_args.args[0]
        self.assertEqual(command[-2:], ["--model-policy", path])
        self.assertNotIn("fixture-key", str(process.call_args))

    def test_direct_dry_run_keeps_source_default_and_legacy_environment(self):
        selected = {"provider": "local-qwen", "model": "Qwen3.8-27B"}
        (self.root / "config/business-model-default.json").write_text(json.dumps({
            "schema_version": "1.2", "default": selected,
        }), encoding="utf-8")
        managed = self.root / "candidate/managed"
        managed.mkdir(parents=True)
        (managed / "example-agent.patch.yml").write_text(
            "- id: agent-default-model\n  config:\n    provider: local-qwen\n    model: Qwen3.8-27B\n"
            "- id: llm-pi-ai\n  config:\n    providers:\n      local-qwen:\n"
            "        models:\n          - id: Qwen3.8-27B\n",
            encoding="utf-8",
        )
        contract = {**self.contract, "managed": str(managed),
                    "patch": "/opt/dsh-managed/example-agent.patch.yml"}
        direct = evaluation.dry_run_payload(contract, self.cases, "api", "fast", "explicit", "none")
        self.assertEqual(direct["required_env_names"], self.contract["required_env_names"])
        self.assertIn("DEEPSEEK_API_KEY", direct["missing_env_names"])

    def test_source_only_draft_preview_does_not_load_runtime_model_policy(self):
        args = types.SimpleNamespace(source=self.contract["source_id"], case=["U-INS-001"], mode="fast",
                                     executor="api", review="none", model=None, model_policy=None,
                                     compare_to=None, dry_run=True, source_check=True)
        self.patch(mock.patch.object(evaluation, "resolve", return_value=self.contract))
        self.patch(mock.patch.object(evaluation, "load_evaluation", return_value={}))
        self.patch(mock.patch.object(evaluation, "select_case_ids", return_value=["U-INS-001"]))
        self.patch(mock.patch.object(evaluation, "execution_for", return_value=self.cases))
        with mock.patch.object(evaluation, "DSH_DEV", self.root / "missing-dsh-dev"), \
                mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(evaluation.execute(args), 0)
        plan = json.loads(output.getvalue())
        self.assertEqual(plan["required_env_names"], self.contract["required_env_names"])
        self.assertEqual(plan["case_ids"], ["U-INS-001"])
        self.assertEqual(plan["preflight_scope"], "source-and-cases")

    def test_source_check_cannot_replace_runtime_model_preflight(self):
        args = types.SimpleNamespace(source=self.contract["source_id"], case=["U-INS-001"], mode="fast",
                                     executor="api", review="none", model=None, model_policy=None,
                                     compare_to=None, dry_run=False, source_check=True)
        with self.assertRaisesRegex(evaluation.EvaluationError, "--source-check"):
            evaluation.execute(args)
        args.dry_run = True
        args.model = "MiMo-V2.6-Flash"
        with self.assertRaisesRegex(evaluation.EvaluationError, "--source-check"):
            evaluation.execute(args)
        args.model = None
        args.source_check = False
        self.patch(mock.patch.object(evaluation, "resolve", return_value=self.contract))
        self.patch(mock.patch.object(evaluation, "load_evaluation", return_value={}))
        self.patch(mock.patch.object(evaluation, "select_case_ids", return_value=["U-INS-001"]))
        self.patch(mock.patch.object(evaluation, "execution_for", return_value=self.cases))
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(evaluation.EvaluationError, "--model-policy"):
            evaluation.execute(args)

    def test_missing_business_environment_blocks_before_validation_or_run_creation(self):
        args = types.SimpleNamespace(source=self.contract["source_id"], case=["U-INS-001"], mode="fast",
                                     executor="api", review="none", model="MiMo-V2.6-Flash",
                                     model_policy=str(self.policy), compare_to=None, dry_run=False)
        self.patch(mock.patch.object(evaluation, "resolve", return_value=self.contract))
        self.patch(mock.patch.object(evaluation, "load_evaluation", return_value={}))
        self.patch(mock.patch.object(evaluation, "select_case_ids", return_value=["U-INS-001"]))
        self.patch(mock.patch.object(evaluation, "execution_for", return_value=self.cases))
        validation = self.patch(mock.patch.object(evaluation, "validate_before_run", return_value={"repository": {"valid": True}}))
        run = self.patch(mock.patch.object(evaluation, "execute_owned_run", return_value=0))
        self.patch(mock.patch.object(evaluation, "emit_result"))
        with mock.patch.dict(os.environ, {"XIAOMI_TOKEN_PLAN_CN_API_KEY": "fixture-key"}, clear=True), \
                redirect_stderr(io.StringIO()):
            self.assertEqual(evaluation.execute(args), 2)
        validation.assert_not_called()
        run.assert_not_called()
        with mock.patch.dict(os.environ, {"XIAOMI_TOKEN_PLAN_CN_API_KEY": "fixture-key", "OPS_MCP_URL": "http://tools"}, clear=True):
            self.assertEqual(evaluation.execute(args), 0)
        validation.assert_called_once()
        run.assert_called_once()

    def test_expected_model_and_policy_identity_must_match_before_run(self):
        with self.assertRaisesRegex(evaluation.EvaluationError, "--model 与实例默认模型不一致"):
            evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none",
                                       str(self.policy), "other-model")
        with self.assertRaisesRegex(evaluation.EvaluationError, "--model 与实例默认模型不一致"):
            evaluation.dry_run_payload(self.contract, self.cases, "api", "fast", "explicit", "none",
                                       expected_model="other-model")
        wrong_agent = dict(self.contract, agent_id="another-agent")
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(evaluation.EvaluationError, "模型策略不可用"):
            evaluation.dry_run_payload(wrong_agent, self.cases, "api", "fast", "explicit", "none",
                                       str(self.policy))


class EvaluationInterpreterTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="dsh eval interpreter ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "config").mkdir()
        (self.root / "config/sites.json").write_text(json.dumps({"platform": "/hep/", "assistant": "/assistant/"}))
        binary = self.root / "bin"
        binary.mkdir()
        fallback = binary / "python3"
        fallback.write_text("#!/bin/sh\necho unavailable-python3 >&2\nexit 77\n")
        fallback.chmod(0o755)
        environment = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                           HARNESS_PYTHON=sys.executable)
        environment.pop("DSH_EVAL_DSH_DEV", None)
        self.patch(mock.patch.dict(os.environ, environment, clear=True))
        self.patch(mock.patch.object(evaluation, "REPO", self.root))

    def patch(self, patcher):
        self.addCleanup(patcher.stop)
        return patcher.start()

    def children(self):
        for key, name in (("VALIDATE_REPOSITORY", "validate_repository.py"),
                          ("VALIDATE_EXPERIMENT", "validate_experiment.py"),
                          ("RUN_RECORD", "run_record.py"), ("DSH_DEV", "dsh-dev")):
            script = self.root / name
            script.write_text(CHILD)
            self.patch(mock.patch.object(evaluation, key, script))

    def calls(self):
        return [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]

    def test_validation_runs_real_scripts_with_parent_python_despite_unusable_path_python(self):
        checks = evaluation.validate_before_run({"experiment_root": str(self.root)})
        for check in checks.values():
            self.assertFalse(check["valid"])
            self.assertIn("error_codes", check, check)
            self.assertNotEqual(check["exit_code"], 77)

    def test_run_lifecycle_and_default_instance_children_keep_parent_python(self):
        self.children()
        contract = {"experiment_root": str(self.root)}
        self.assertTrue(all(check["valid"] for check in evaluation.validate_before_run(contract).values()))
        evaluation.validate_after_run(contract)
        run_id = evaluation.initialize_run("fixture", [{"case_id": "U-BASIC-001"}], "api", "explicit", "none")
        evaluation.record_trial(run_id, "U-BASIC-001", {
            "execution_status": "completed", "verdict": "passed", "observation": "模拟状态正常",
            "evidence_ref": "evidence/U-BASIC-001/checks.json",
        })
        evaluation.finalize_run(run_id, "completed")
        evaluation.start_instance("fixture", "fixture")
        evaluation.authentication_url("fixture")
        self.assertTrue(evaluation.stop_instance("fixture"))
        calls = self.calls()
        self.assertEqual([row["script"] for row in calls], [
            "validate_repository.py", "validate_experiment.py", "validate_experiment.py",
            "run_record.py", "run_record.py", "run_record.py", "dsh-dev", "dsh-dev", "dsh-dev",
        ])
        self.assertEqual(calls[0]["args"], [str(self.root), "--experiment", self.root.name])
        self.assertEqual({row["python"] for row in calls}, {sys.executable})
        self.assertEqual([row["args"][0] for row in calls[-3:]], ["up", "url", "down"])

    def test_review_and_custom_non_python_instance_entry_preserve_execution_semantics(self):
        self.children()
        import scenario_analysis
        self.patch(mock.patch.object(scenario_analysis, "ADAPTER", self.root))
        self.patch(mock.patch.object(scenario_analysis, "_locked_harness", return_value=[]))
        self.patch(mock.patch.object(scenario_analysis, "_target_route", return_value={}))
        self.patch(mock.patch.object(scenario_analysis, "_review_driver", side_effect=RuntimeError("fixture-driver-stop")))
        override = self.root / "custom-entry"
        override.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(self.root / 'dsh-dev'))} \"$@\"\n")
        override.chmod(0o755)
        for custom in (False, True):
            if custom:
                os.environ["DSH_EVAL_DSH_DEV"] = str(override)
                evaluation.start_instance("fixture", "fixture")
                evaluation.authentication_url("fixture")
                self.assertTrue(evaluation.stop_instance("fixture"))
            run = self.root / "evolution/experiments/EXP-fixture-001/runs" / str(custom)
            scenario_analysis.review_full(run, [], {"run_id": "run-fixture", "source_id": "fixture", "evaluation_cases": [], "case_catalog": []},
                                          model_policy_path=str(self.root / "model-policy.json") if custom else None)
        calls = self.calls()
        self.assertEqual([row["args"][0] for row in calls], ["up", "url", "down"] * 3)
        self.assertEqual({row["python"] for row in calls}, {sys.executable})
        self.assertEqual(calls[6]["args"][-2:], ["--model-policy", str(self.root / "model-policy.json")])

    def test_validator_failure_keeps_exit_status_and_safe_diagnostic_in_progress(self):
        self.children()
        os.environ["FIXTURE_API_KEY"] = "fixture-private-value"
        failure = "import sys\nprint('RuntimeError: fixture-private-value token=fixture-secret', file=sys.stderr)\nsys.exit(17)\n"
        evaluation.VALIDATE_REPOSITORY.write_text(failure)
        evaluation.VALIDATE_EXPERIMENT.write_text(failure)
        contract = {"experiment_root": str(self.root), "experiment_id": "EXP-fixture-001", "agent_id": "fixture"}
        check = evaluation.validate_before_run(contract)["repository"]
        self.assertEqual(check["exit_code"], 17)
        self.assertEqual(check["error"], "RuntimeError: <redacted> token=<redacted>")
        with self.assertRaisesRegex(evaluation.EvaluationError, "退出码 17.*RuntimeError"):
            evaluation.validate_after_run(contract)
        for name, result in (("resolve", contract), ("load_evaluation", {}), ("select_case_ids", []),
                             ("execution_for", []), ("dry_run_payload", {"missing_env_names": []})):
            self.patch(mock.patch.object(evaluation, name, return_value=result))
        self.patch(mock.patch.object(evaluation, "emit_result"))
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = evaluation.execute(types.SimpleNamespace(source="fixture", case=[], mode="fast", executor="api",
                                       review="none", compare_to=None, dry_run=False))
        self.assertEqual(result, 2)
        self.assertIn("repository（退出码 17）：RuntimeError", stderr.getvalue())
        self.assertNotIn("fixture-private-value", stderr.getvalue())
        self.assertNotIn("fixture-secret", stderr.getvalue())
        self.assertNotIn("JSONDecodeError", stderr.getvalue())


class SeparateReviewTest(unittest.TestCase):
    ROUTE = {"provider": "fixture-review", "model": "review-model", "reasoningEffort": "off"}

    def setUp(self):
        import scenario_analysis
        self.analysis = scenario_analysis
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.run = self.root / "evolution/experiments/EXP-audit-001/runs/run-audit"
        self.evidence = self.run / "evidence/U-ONE-001"
        self.evidence.mkdir(parents=True)
        self.inputs = {"run_id": "run-audit", "source_id": "experiment:EXP-audit-001", "review_mode": "ai",
                       "evaluation_cases": [{"case_id": "U-ONE-001", "inputs": ["第一轮", "第二轮"], "expected_behavior": "保留编号并返回真实产物"}],
                       "case_catalog": [{"case_id": "U-ONE-001", "scene": "业务场景"}],
                       "harness_trees": {"managed": {"files": [{"path": "guard.ts", "sha256": "c" * 64, "size": 100}]}},
                       "harness_review": {"schema_version": 1, "generated": [], "sources": [{"origin": "platform", "path": "sdk.ts", "sha256": "d" * 64, "content": "SOURCE-BODY-ONLY" * 12000}]}}
        self.rows = [{"input_id": "U-ONE-001", "execution_status": "completed", "verdict": "inconclusive", "evidence_ref": "evidence/U-ONE-001/checks.json"}]
        for name, content in {"response.json": {"assistant_texts": ["第一轮编号A", "第二轮保留A"], "turns": [{"input": "第一轮"}, {"input": "第二轮"}]},
                              "checks.json": {"trace_available": True, "preset_matches": True, "workspace_matches": True}}.items():
            (self.evidence / name).write_text(json.dumps(content, ensure_ascii=False))
        (self.evidence / "tools.jsonl").write_text(json.dumps({"event": {"type": "tool/result", "data": {"arguments": {"id": "A"}, "result": {"id": "A", "value": 70}}}}) + "\n")
        (self.evidence / "trace.jsonl").write_text(json.dumps({"session_log": "root", "event": {"type": "turn/end", "seq": 9, "data": {"turn": 2}}}) + "\n")
        (self.run / "results.jsonl").write_text(json.dumps(self.rows[0]) + "\n")
        loader = SourceFileLoader("separate_review_fixture_dev", str(Path(__file__).with_name("dsh-dev")))
        module_spec = importlib.util.spec_from_loader(loader.name, loader)
        dev = importlib.util.module_from_spec(module_spec)
        loader.exec_module(dev)
        raw_policy = {"agent_id": "audit", "manifest_sha256": "a" * 64, "business_model_revision": "b" * 64,
                      "allowed": [{"provider": self.ROUTE["provider"], "model": self.ROUTE["model"]}], "default": self.ROUTE,
                      "patch": [{"id": "agent-default-model", "config": self.ROUTE}], "credential_refs": []}
        policy = dev.analysis_model_policy("audit", dev._model_policy(raw_policy, "audit", source="platform", manifest_sha256="a" * 64))
        policy_path = self.run / "evidence/analysis/model-policy.json"
        policy_path.parent.mkdir()
        policy_path.write_text(json.dumps(raw_policy))
        self.inputs["review_contract"] = {"schema_version": 1, "effect_scope": "business-evidence", "source_scope": "frozen-harness",
                                         "model_route": self.ROUTE, "model_policy_sha256": policy["sha256"],
                                         "model_policy_snapshot": {"path": "evidence/analysis/model-policy.json", "sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest()}}
        self.write_inputs()
        self.lock_before = (self.run / "inputs.lock.json").read_bytes()
        self.source_files = [{"tree": "managed", "path": "guard.ts", "sha256": "c" * 64,
                              "content": "SOURCE-BODY-ONLY" * 12000, "classification": "source"}]
        self.tasks = []
        self.partial = set()
        self.same_session = False

    def write_inputs(self):
        (self.run / "inputs.lock.json").write_text(json.dumps(self.inputs, ensure_ascii=False))

    def driver(self, prompts, _url, _image, route, _timeout, _root):
        results = []
        for prompt in prompts:
            value = json.loads(prompt["prompt"])
            task = value["review_task"]
            self.tasks.append(task)
            accesses = []
            for item in value["required_evidence"]:
                lines = list(range(1, item["total_lines"] + 1))
                if task in self.partial:
                    lines = lines[:-1]
                accesses.append({"name": "read", "arguments": {"file_path": item["path"]},
                                 "result": {"is_error": False, "read": {"path": item["path"], "offset": 1, "line_numbers": lines, "total_lines": item["total_lines"]}}})
            output = {"findings": []}
            if task == "effect":
                output["case_reviews"] = [{"case_id": case["case_id"], "reviewed_verdict": "passed", "reason": "完整业务执行证据符合冻结预期"} for case in value["cases"]]
                self.assertNotIn("inputs.lock.json", value["evidence_sources"])
                self.assertNotIn("evidence/analysis/harness.json", value["evidence_sources"])
                projection = self.analysis._safe_json(self.run / "evidence/analysis/effect-inputs.json")
                self.assertNotIn("SOURCE-BODY-ONLY", json.dumps(projection))
                self.assertEqual(projection["inputs"]["harness_review"]["sources"][0]["sha256"], "d" * 64)
                self.assertIn("evidence/U-ONE-001/trace.jsonl", value["evidence_sources"])
            results.append({"scene_id": prompt["scene_id"], "session_id": "effect-scene-01" if self.same_session else f"{task}-{prompt['scene_id']}",
                            "route": route, "text": json.dumps(output), "tool_names": self.analysis.ANALYSIS_TOOLS,
                            "tool_accesses": accesses})
        return {"operation": "review", "results": results}

    def review(self, *, source_error=None):
        def run(command, **_kwargs):
            if "up" in command:
                self.assertIn(str((self.run / "evidence/analysis/model-policy.json").resolve()), command)
                return json.dumps({"image_ref": "image@sha256:fixture"})
            return "http://127.0.0.1:3081/?token=fixture-only" if "url" in command else ""
        with mock.patch.object(self.analysis, "_run", side_effect=run), \
                mock.patch.object(self.analysis, "_locked_harness", side_effect=source_error, return_value=self.source_files), \
                mock.patch.object(self.analysis, "_target_route", side_effect=AssertionError("新方法不能从业务模型猜评审路由")), \
                mock.patch.object(self.analysis, "_review_driver", side_effect=self.driver):
            result = self.analysis.review_full(self.run, self.rows, self.inputs)
            self.analysis.validate_analysis(result, self.run, self.rows, self.inputs)
        self.assertEqual((self.run / "inputs.lock.json").read_bytes(), self.lock_before)
        return result

    def test_source_incomplete_does_not_erase_complete_effect_and_true_read_scope(self):
        self.partial = {"source"}
        result = self.review()
        self.assertEqual(self.tasks, ["effect", "source"])
        self.assertEqual(result["schema_version"], "3.0")
        self.assertEqual(result["review_status"], "completed")
        self.assertEqual(self.analysis.summarize_review(result)["overall_verdict"], "passed")
        source = result["source_diagnosis"]
        self.assertEqual((source["status"], source["conclusion"]), ("incomplete", "inconclusive"))
        self.assertTrue(any(item["read_ranges"] for item in source["scope"]))
        self.assertTrue(any(not item["complete"] for item in source["scope"]))
        self.assertEqual(source["findings"], [])
        self.assertNotEqual(source["analysis_session"]["session_id"], result["scenes"][0]["analysis_session"]["session_id"])

    def test_source_complete_is_scoped_no_findings_not_code_passed(self):
        result = self.review()
        self.assertEqual(result["source_diagnosis"]["conclusion"], "no_findings")
        summary = self.analysis.summarize_source_diagnosis(result)
        self.assertEqual(summary["status"], "completed")
        self.assertEqual(summary["required_parts"], summary["read_parts"])

    def test_source_completion_cannot_upgrade_unread_effect(self):
        self.partial = {"effect"}
        result = self.review()
        self.assertEqual(result["review_status"], "failed")
        self.assertEqual(result["source_diagnosis"]["status"], "completed")
        self.assertEqual(result["reviewed_case_count"], 0)

    def test_missing_source_bytes_only_mark_source_unknown(self):
        result = self.review(source_error=ValueError("harness-lock-digest-mismatch"))
        self.assertEqual(self.tasks, ["effect"])
        self.assertEqual(result["review_status"], "completed")
        self.assertEqual(result["source_diagnosis"]["status"], "incomplete")
        self.assertEqual(result["source_diagnosis"]["scope"], [])

    def test_shared_session_is_rejected_without_changing_effect(self):
        self.same_session = True
        result = self.review()
        self.assertEqual(result["review_status"], "completed")
        self.assertEqual(result["source_diagnosis"]["status"], "incomplete")
        self.assertIsNone(result["source_diagnosis"]["analysis_session"])

    def test_failed_effect_session_also_cannot_be_reused_for_source(self):
        self.same_session = True
        self.partial = {"effect"}
        result = self.review()
        self.assertEqual(result["review_status"], "failed")
        self.assertEqual(result["source_diagnosis"]["status"], "incomplete")
        self.assertIsNone(result["source_diagnosis"]["analysis_session"])

    def test_forged_source_coverage_or_effect_verdict_is_rejected(self):
        result = self.review()
        result["source_diagnosis"]["scope"][0]["read_ranges"] = []
        with self.assertRaisesRegex(ValueError, "scope-mismatch"):
            self.analysis.validate_analysis(result, self.run, self.rows, self.inputs)
        result["source_diagnosis"]["scope"][0]["read_ranges"] = [[1, result["source_diagnosis"]["scope"][0]["total_lines"]]]
        result["scenes"][0]["case_reviews"][0]["reviewed_verdict"] = "failed"
        with self.assertRaisesRegex(ValueError, "effect-review-output-mismatch"):
            self.analysis.validate_analysis(result, self.run, self.rows, self.inputs)

    def test_snapshot_missing_or_marker_invalid_never_falls_back_to_target(self):
        path = self.run / self.inputs["review_contract"]["model_policy_snapshot"]["path"]
        path.unlink()
        with self.assertRaisesRegex(ValueError, "snapshot-missing"):
            self.analysis._review_route(self.run, self.inputs)
        self.inputs["review_contract"]["schema_version"] = True
        with self.assertRaisesRegex(ValueError, "review-contract-invalid"):
            self.analysis._review_route(self.run, self.inputs)

    def test_actual_artifact_is_required_and_tampering_is_not_effect_success(self):
        artifact = self.run / "artifacts/U-ONE-001/report.md"
        artifact.parent.mkdir(parents=True)
        artifact.write_text("实际报告A，金额70元。")
        index = {"schema_version": "1.0", "artifacts": [{"case_id": "U-ONE-001", "path": "artifacts/U-ONE-001/report.md", "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(), "size": artifact.stat().st_size}]}
        (self.run / "artifacts/index.json").write_text(json.dumps(index))
        result = self.review()
        self.assertEqual(result["review_status"], "completed")
        projected = self.analysis._safe_json(self.run / "evidence/analysis/business-artifacts.json")
        self.assertEqual(projected["artifacts"][0]["content"], artifact.read_text())
        artifact.write_text("伪造产物")
        with self.assertRaisesRegex(ValueError, "mismatch"):
            self.analysis.validate_analysis(result, self.run, self.rows, self.inputs)

    def test_manifest_cannot_omit_required_execution_or_harness_sources(self):
        result = self.review()
        manifest_path = self.run / "evidence/analysis/readable/manifest.json"
        original = manifest_path.read_bytes()
        for bundle, source in [("scene-01", "evidence/U-ONE-001/trace.jsonl"),
                               ("source-diagnosis", "evidence/analysis/harness.json")]:
            with self.subTest(bundle=bundle):
                manifest = json.loads(original)
                group = next(item for item in manifest["groups"] if item["bundle"] == bundle)
                group["sources"] = [item for item in group["sources"] if item["source"] != source]
                manifest_path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, "source-coverage-invalid"):
                    self.analysis.validate_analysis(result, self.run, self.rows, self.inputs)
                manifest_path.write_bytes(original)

    def test_none_mode_has_two_explicit_not_requested_states(self):
        self.inputs["review_mode"] = "none"
        self.write_inputs()
        result = self.analysis.analyze(self.run, self.rows, self.inputs, status="completed")
        self.analysis.validate_analysis(result, self.run, self.rows, self.inputs)
        self.assertEqual(result["review_status"], "not_requested")
        self.assertEqual(result["source_diagnosis"]["status"], "not_requested")


if __name__ == "__main__":
    unittest.main()
