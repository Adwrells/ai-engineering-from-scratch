import unittest
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import (
    CLIENT_CAPABILITIES_KEY,
    CLIENT_INFO_KEY,
    PROTOCOL_KEY,
    PROTOCOL_VERSION,
    SERVER_INFO_KEY,
    SUPPORTED_VERSIONS,
    MCPClient,
    request_metadata,
    server,
)


def envelope(method, params=None, request_id=1):
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params or {},
    }


class StatelessMCPTests(unittest.TestCase):
    def test_request_metadata_carries_version_capabilities_and_identity(self):
        metadata = request_metadata()
        self.assertEqual(PROTOCOL_VERSION, metadata[PROTOCOL_KEY])
        self.assertEqual({}, metadata[CLIENT_CAPABILITIES_KEY])
        self.assertEqual("demo-client", metadata[CLIENT_INFO_KEY]["name"])

    def test_discover_returns_identity_capabilities_and_cache_policy(self):
        client = MCPClient(server)
        result = client.request("server/discover")
        self.assertEqual("complete", result["resultType"])
        self.assertEqual(list(SUPPORTED_VERSIONS), result["supportedVersions"])
        self.assertEqual("demo-server", result["_meta"][SERVER_INFO_KEY]["name"])
        self.assertGreater(result["ttlMs"], 0)
        self.assertIn(result["cacheScope"], {"public", "private"})

    def test_missing_metadata_is_rejected(self):
        response = server.handle(envelope("tools/list"))
        self.assertEqual(-32602, response["error"]["code"])

    def test_missing_protocol_version_is_invalid_params(self):
        metadata = request_metadata()
        del metadata[PROTOCOL_KEY]
        response = server.handle(envelope("tools/list", {"_meta": metadata}))
        self.assertEqual(-32602, response["error"]["code"])
        self.assertNotIn("data", response["error"])

    def test_non_string_protocol_version_is_invalid_params(self):
        metadata = request_metadata()
        metadata[PROTOCOL_KEY] = 20260728
        response = server.handle(envelope("tools/list", {"_meta": metadata}))
        self.assertEqual(-32602, response["error"]["code"])

    def test_missing_client_capabilities_is_invalid_params(self):
        metadata = request_metadata()
        del metadata[CLIENT_CAPABILITIES_KEY]
        response = server.handle(envelope("tools/list", {"_meta": metadata}))
        self.assertEqual(-32602, response["error"]["code"])

    def test_unsupported_protocol_version_returns_spec_error(self):
        metadata = request_metadata(protocol_version="2025-11-25")
        response = server.handle(envelope("tools/list", {"_meta": metadata}))
        self.assertEqual(-32022, response["error"]["code"])
        self.assertEqual(list(SUPPORTED_VERSIONS), response["error"]["data"]["supported"])
        self.assertEqual("2025-11-25", response["error"]["data"]["requested"])

    def test_tool_list_is_deterministic_and_cacheable(self):
        result = MCPClient(server).request("tools/list")
        self.assertEqual(["add", "delete_user"], [tool["name"] for tool in result["tools"]])
        self.assertEqual("private", result["cacheScope"])

    def test_tool_call_returns_typed_complete_result(self):
        result = MCPClient(server).request(
            "tools/call", {"name": "add", "arguments": {"a": 20, "b": 22}}
        )
        self.assertEqual("complete", result["resultType"])
        self.assertEqual('{"sum": 42}', result["content"][0]["text"])
        self.assertIn(SERVER_INFO_KEY, result["_meta"])

    def test_resource_read_is_cacheable(self):
        result = MCPClient(server).request("resources/read", {"uri": "config://app"})
        self.assertEqual("complete", result["resultType"])
        self.assertEqual("private", result["cacheScope"])

    def test_resource_list_includes_required_name(self):
        result = MCPClient(server).request("resources/list")
        self.assertEqual("app-config", result["resources"][0]["name"])

    def test_every_success_result_is_typed_and_identifies_server(self):
        calls = [
            ("server/discover", None),
            ("tools/list", None),
            ("tools/call", {"name": "add", "arguments": {"a": 1, "b": 2}}),
            ("resources/list", None),
            ("resources/read", {"uri": "config://app"}),
            ("prompts/list", None),
            (
                "prompts/get",
                {"name": "code_review", "arguments": {"language": "Python", "code": "x=1"}},
            ),
        ]
        client = MCPClient(server)
        for method, params in calls:
            with self.subTest(method=method):
                result = client.request(method, params)
                self.assertEqual("complete", result["resultType"])
                self.assertEqual("demo-server", result["_meta"][SERVER_INFO_KEY]["name"])

    def test_notification_is_ignored_without_a_json_rpc_response(self):
        response = server.handle(
            {
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": {"requestId": 1},
            }
        )
        self.assertIsNone(response)

    def test_null_request_id_is_invalid(self):
        response = server.handle(
            envelope("tools/list", {"_meta": request_metadata()}, request_id=None)
        )
        self.assertEqual(-32600, response["error"]["code"])
        self.assertIsNone(response["id"])

    def test_wrong_json_rpc_version_is_invalid(self):
        message = envelope("tools/list", {"_meta": request_metadata()}, request_id=12)
        message["jsonrpc"] = "1.0"
        response = server.handle(message)
        self.assertEqual(12, response["id"])
        self.assertEqual(-32600, response["error"]["code"])

    def test_unknown_method_uses_json_rpc_method_not_found(self):
        response = server.handle(
            envelope("unknown/method", {"_meta": request_metadata()}, request_id=9)
        )
        self.assertEqual(9, response["id"])
        self.assertEqual(-32601, response["error"]["code"])


if __name__ == "__main__":
    unittest.main()
