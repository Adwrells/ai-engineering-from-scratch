"""Tests for current MCP authorization and stateless requests."""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "main.py"
SPEC = importlib.util.spec_from_file_location("lesson16_main", MODULE_PATH)
assert SPEC and SPEC.loader
main = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = main
SPEC.loader.exec_module(main)


class OAuthLessonTests(unittest.TestCase):
    def test_discover_uses_current_result_shape(self):
        server = main.ResourceServer()
        body, headers = main.make_discover_request(7)
        status, response, _ = server.discover(body, headers)
        self.assertEqual(status, 200)
        self.assertEqual(response["id"], 7)
        self.assertEqual(response["result"]["resultType"], "complete")
        self.assertEqual(response["result"]["supportedVersions"], [main.PROTOCOL_VERSION])
        self.assertEqual(response["result"]["_meta"][main.SERVER_INFO_META], main.SERVER_INFO)

    def test_tools_list_is_advertised_complete_and_deterministic(self):
        server = main.ResourceServer()
        body, headers = main.make_tools_list_request(8)
        status, first, _ = server.handle(body, headers)
        body, headers = main.make_tools_list_request(9)
        _, second, _ = server.handle(body, headers)
        self.assertEqual(status, 200)
        discover_body, discover_headers = main.make_discover_request()
        _, discovery, _ = server.discover(discover_body, discover_headers)
        self.assertIn("tools", discovery["result"]["capabilities"])
        tools = first["result"]["tools"]
        self.assertEqual(tools, second["result"]["tools"])
        self.assertEqual([tool["name"] for tool in tools], sorted(tool["name"] for tool in tools))
        self.assertTrue(all(tool["inputSchema"]["type"] == "object" for tool in tools))
        self.assertEqual(first["result"]["resultType"], "complete")
        self.assertGreater(first["result"]["ttlMs"], 0)
        self.assertEqual(first["result"]["cacheScope"], "public")
        self.assertEqual(first["result"]["_meta"][main.SERVER_INFO_META], main.SERVER_INFO)

    def test_protected_resource_metadata_selects_issuer_and_path(self):
        metadata = main.ResourceServer().protected_resource_metadata()
        self.assertEqual(metadata["resource"], main.RESOURCE)
        self.assertEqual(metadata["authorization_servers"], [main.ISSUER])
        self.assertEqual(
            main.RESOURCE_METADATA_URI,
            "https://notes.example.com/.well-known/oauth-protected-resource/mcp",
        )

    def test_cimd_client_id_is_metadata_url(self):
        auth = main.AuthorizationServer()
        client = main.Client()
        client_id = client.enroll(auth)
        self.assertEqual(client_id, main.CLIENT_METADATA_URL)
        self.assertEqual(auth.clients[client_id]["enrollment"], "cimd")

    def test_cimd_requires_path_but_not_application_type(self):
        auth = main.AuthorizationServer()
        document = {
            "client_id": "https://client.example.com/client.json",
            "client_name": "Portable client",
            "redirect_uris": ["https://client.example.com/callback"],
        }
        self.assertEqual(auth.enroll_cimd(document["client_id"], document), document["client_id"])
        with self.assertRaisesRegex(ValueError, "with a path"):
            auth.enroll_cimd(
                "https://client.example.com",
                {**document, "client_id": "https://client.example.com"},
            )

    def test_dcr_fallback_declares_application_type(self):
        auth = main.AuthorizationServer(supports_cimd=False)
        client = main.Client(application_type="native")
        client_id = client.enroll(auth)
        self.assertEqual(auth.clients[client_id]["application_type"], "native")
        self.assertEqual(auth.clients[client_id]["enrollment"], "dcr-compatibility")

    def test_dcr_rejects_missing_application_type(self):
        auth = main.AuthorizationServer(supports_cimd=False)
        with self.assertRaisesRegex(ValueError, "application_type"):
            auth.dynamic_register({"redirect_uris": ["http://127.0.0.1/callback"]})

    def test_web_client_rejects_loopback_redirect(self):
        auth = main.AuthorizationServer()
        document = {
            "client_id": main.CLIENT_METADATA_URL,
            "client_name": "Web client",
            "application_type": "web",
            "redirect_uris": ["http://127.0.0.1/callback"],
        }
        with self.assertRaisesRegex(ValueError, "remote HTTPS"):
            auth.enroll_cimd(main.CLIENT_METADATA_URL, document)

    def test_authorization_response_issuer_is_validated(self):
        auth = main.AuthorizationServer()
        client = main.Client()
        client.enroll(auth)
        real_authorize = auth.authorize

        def wrong_issuer(**kwargs):
            response = real_authorize(**kwargs)
            response["iss"] = "https://attacker.example"
            return response

        auth.authorize = wrong_issuer
        with self.assertRaisesRegex(ValueError, "issuer mismatch"):
            client.authorize(auth, main.RESOURCE, {"notes:read"})

    def test_credentials_are_keyed_by_issuer(self):
        first = main.AuthorizationServer(issuer="https://auth-one.example", supports_cimd=False)
        second = main.AuthorizationServer(issuer="https://auth-two.example", supports_cimd=False)
        client = main.Client()
        first_id = client.enroll(first)
        second_id = client.enroll(second)
        self.assertEqual(set(client.client_ids_by_issuer), {first.issuer, second.issuer})
        self.assertNotEqual(first_id, second_id)

    def test_resource_rejects_other_audience_with_json_rpc_error(self):
        server = main.ResourceServer()
        token = main.Token(
            value="t",
            issuer=server.issuer,
            audience="https://other.example/mcp",
            subject="alice",
            client_id="c",
            scopes=frozenset({"notes:read"}),
            expires_at=10**20,
        )
        body, headers = main.make_mcp_request(21, "notes.list")
        status, response, response_headers = server.call(body, headers, token)
        self.assertEqual(status, 401)
        self.assertEqual(response["jsonrpc"], "2.0")
        self.assertEqual(response["id"], 21)
        self.assertEqual(response["error"]["code"], -32001)
        self.assertIn(main.RESOURCE_METADATA_URI, response_headers["WWW-Authenticate"])

    def test_step_up_requests_only_missing_scope(self):
        auth = main.AuthorizationServer()
        server = main.ResourceServer()
        client = main.Client()
        status, response, _ = client.call_with_step_up("notes.delete", server, auth)
        self.assertEqual(status, 200)
        self.assertEqual(response["result"]["resultType"], "complete")
        token = client.tokens_by_issuer_resource[(auth.issuer, server.resource)]
        self.assertEqual(token.scopes, frozenset({"notes:read", "notes:delete"}))

    def test_routing_header_mismatch_is_json_rpc_400(self):
        server = main.ResourceServer()
        body, headers = main.make_mcp_request(31, "notes.list")
        headers["Mcp-Name"] = "notes.delete"
        status, response, _ = server.call(body, headers, None)
        self.assertEqual(status, 400)
        self.assertEqual(response["id"], 31)
        self.assertEqual(response["error"]["code"], -32020)

    def test_header_version_mismatch_precedes_support_check(self):
        server = main.ResourceServer()
        body, headers = main.make_tools_list_request(32)
        body["params"]["_meta"][main.PROTOCOL_META] = "2025-11-25"
        status, response, _ = server.handle(body, headers)
        self.assertEqual(status, 400)
        self.assertEqual(response["error"]["code"], -32020)

    def test_unsupported_version_has_exact_error_data(self):
        server = main.ResourceServer()
        body, headers = main.make_tools_list_request(33)
        requested = "2025-11-25"
        body["params"]["_meta"][main.PROTOCOL_META] = requested
        headers["MCP-Protocol-Version"] = requested
        status, response, _ = server.handle(body, headers)
        self.assertEqual(status, 400)
        self.assertEqual(response["id"], 33)
        self.assertEqual(response["error"]["code"], -32022)
        self.assertEqual(
            response["error"]["data"],
            {"supported": [main.PROTOCOL_VERSION], "requested": requested},
        )

    def test_unknown_method_is_json_rpc_404(self):
        server = main.ResourceServer()
        body, headers = main.make_tools_list_request(34)
        body["method"] = "widgets/list"
        headers["Mcp-Method"] = "widgets/list"
        status, response, _ = server.handle(body, headers)
        self.assertEqual(status, 404)
        self.assertEqual(response["id"], 34)
        self.assertEqual(response["error"]["code"], -32601)

    def test_accepted_notification_returns_empty_202(self):
        server = main.ResourceServer()
        body, headers = main.make_tools_list_request(35)
        del body["id"]
        self.assertEqual(server.handle(body, headers), (202, None, {}))

    def test_mcp_request_has_no_session_identifier(self):
        body, headers = main.make_mcp_request(1, "notes.list")
        self.assertNotIn("Mcp-Session-Id", headers)
        self.assertEqual(body["params"]["_meta"][main.PROTOCOL_META], main.PROTOCOL_VERSION)
        self.assertIn(main.CLIENT_CAPABILITIES_META, body["params"]["_meta"])

    def test_modern_http_entrypoint_error_is_json_rpc_envelope(self):
        server = main.ResourceServer()
        body, headers = main.make_discover_request(36)
        status, response, _ = server.discover(body, headers, http_method="GET")
        self.assertEqual(status, 405)
        self.assertEqual(response["jsonrpc"], "2.0")
        self.assertEqual(response["id"], 36)
        self.assertIn("error", response)


if __name__ == "__main__":
    unittest.main()
