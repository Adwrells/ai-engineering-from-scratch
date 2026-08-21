"""Tests for explicit workspace scope and stateless elicitation."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "main.py"
SPEC = importlib.util.spec_from_file_location("lesson12_main", MODULE_PATH)
assert SPEC and SPEC.loader
main = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = main
SPEC.loader.exec_module(main)


class ScopeAndElicitationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server = main.NotesServer()

    def test_uri_containment_accepts_child(self) -> None:
        self.assertTrue(
            main.uri_within_workspace(
                "file:///Users/alice/Documents/Notes",
                "file:///Users/alice/Documents/Notes/projects/a.md",
            )
        )

    def test_uri_containment_rejects_prefix_and_traversal(self) -> None:
        workspace = "file:///Users/alice/Documents/Notes"
        self.assertFalse(
            main.uri_within_workspace(
                workspace,
                "file:///Users/alice/Documents/Notes-evil/secret.md",
            )
        )
        self.assertFalse(
            main.uri_within_workspace(
                workspace,
                "file:///Users/alice/Documents/Notes/%2e%2e/private.md",
            )
        )

    def test_discovery_uses_modern_complete_result(self) -> None:
        response = self.server.dispatch(
            {
                "jsonrpc": "2.0",
                "id": 0,
                "method": "server/discover",
                "params": {"_meta": main.request_meta()},
            }
        )
        self.assertEqual(response["result"]["resultType"], "complete")
        self.assertEqual(response["result"]["supportedVersions"], ["2026-07-28"])
        self.assertNotIn("roots", response["result"]["capabilities"])

    def test_tools_list_is_deterministic_cacheable_and_described(self) -> None:
        response = self.server.dispatch(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {"_meta": main.request_meta()},
            }
        )
        result = response["result"]
        self.assertEqual(result["resultType"], "complete")
        self.assertEqual(result["ttlMs"], 60_000)
        self.assertEqual(result["cacheScope"], "public")
        self.assertIn(main.SERVER_INFO_META, result["_meta"])
        self.assertEqual(
            [tool["name"] for tool in result["tools"]],
            sorted(tool["name"] for tool in result["tools"]),
        )
        descriptor = result["tools"][0]
        self.assertEqual(descriptor["name"], "notes_delete")
        self.assertEqual(
            descriptor["inputSchema"]["required"],
            ["workspaceUri", "title"],
        )

    def test_initial_delete_returns_embedded_elicitation(self) -> None:
        response = self.server.dispatch(main.tool_request(1))
        result = response["result"]
        self.assertEqual(result["resultType"], "input_required")
        self.assertEqual(
            result["inputRequests"]["delete_choice"]["method"],
            "elicitation/create",
        )
        self.assertEqual(
            result["inputRequests"]["delete_choice"]["params"]["mode"],
            "form",
        )

    def test_accepted_retry_deletes_selected_note(self) -> None:
        server, response, request_ids = main.run_mrtr(action="accept")
        self.assertEqual(request_ids, [1, 2])
        self.assertEqual(response["result"]["resultType"], "complete")
        self.assertEqual(response["result"]["structuredContent"]["noteId"], "note-14")
        self.assertNotIn("note-14", server.notes)

    def test_declined_retry_preserves_notes(self) -> None:
        server, response, _ = main.run_mrtr(action="decline")
        self.assertFalse(response["result"]["structuredContent"]["deleted"])
        self.assertIn("note-14", server.notes)

    def test_out_of_scope_match_is_not_exposed(self) -> None:
        response = self.server.dispatch(main.tool_request(1, title="outside root"))
        self.assertEqual(response["result"]["resultType"], "complete")
        self.assertTrue(response["result"]["isError"])
        self.assertEqual(
            response["result"]["content"][0]["text"],
            "no match in authorized workspace",
        )

    def test_missing_elicitation_capability_is_rejected(self) -> None:
        request = main.tool_request(1)
        request["params"]["_meta"] = main.request_meta(elicitation=False)
        response = self.server.dispatch(request)
        self.assertEqual(response["error"]["code"], -32021)
        self.assertEqual(
            response["error"]["data"],
            {"requiredCapabilities": {"elicitation": {"form": {}}}},
        )

    def test_empty_elicitation_capability_implicitly_supports_form(self) -> None:
        request = main.tool_request(1)
        request["params"]["_meta"][main.CAPABILITIES_META] = {"elicitation": {}}
        response = self.server.dispatch(request)
        self.assertEqual(response["result"]["resultType"], "input_required")
        self.assertEqual(
            response["result"]["inputRequests"]["delete_choice"]["params"]["mode"],
            "form",
        )

    def test_url_only_elicitation_does_not_support_form(self) -> None:
        request = main.tool_request(1)
        request["params"]["_meta"][main.CAPABILITIES_META] = {
            "elicitation": {"url": {}}
        }
        response = self.server.dispatch(request)
        self.assertEqual(response["error"]["code"], -32021)
        self.assertEqual(
            response["error"]["data"],
            {"requiredCapabilities": {"elicitation": {"form": {}}}},
        )

    def test_changed_arguments_cannot_reuse_state(self) -> None:
        first = self.server.dispatch(main.tool_request(1))
        retry = main.tool_request(2, title="shopping")
        retry["params"].update(
            {
                "inputResponses": {
                    "delete_choice": {
                        "action": "accept",
                        "content": {"note_id": "note-14", "confirm": True},
                    }
                },
                "requestState": first["result"]["requestState"],
            }
        )
        response = self.server.dispatch(retry)
        self.assertEqual(response["error"]["code"], -32602)

    def test_unsupported_version_is_rejected(self) -> None:
        request = main.tool_request(1)
        request["params"]["_meta"][main.PROTOCOL_META] = "2025-11-25"
        response = self.server.dispatch(request)
        self.assertEqual(response["error"]["code"], -32022)
        self.assertEqual(
            response["error"]["data"],
            {"supported": [main.PROTOCOL_VERSION], "requested": "2025-11-25"},
        )

    def test_non_string_protocol_version_is_invalid_params(self) -> None:
        request = main.tool_request(1)
        request["params"]["_meta"][main.PROTOCOL_META] = None
        response = self.server.dispatch(request)
        self.assertEqual(response["error"]["code"], -32602)

    def test_notification_never_receives_a_json_rpc_response(self) -> None:
        request = main.tool_request(1, title="no matching note")
        del request["id"]
        self.assertIsNone(self.server.dispatch(request))


if __name__ == "__main__":
    unittest.main()
