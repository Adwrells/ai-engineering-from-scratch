import unittest

import main


def make_tool(name: str) -> dict:
    return {
        "name": name,
        "description": name,
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    }


class McpClientTests(unittest.TestCase):
    def test_modern_request_contains_current_metadata(self) -> None:
        message = main.modern_request(1, "tools/list", {}, main.PROTOCOL_VERSION, {"extensions": {}})
        meta = message["params"]["_meta"]
        self.assertEqual(meta[main.VERSION_KEY], main.PROTOCOL_VERSION)
        self.assertEqual(meta[main.CAPABILITIES_KEY], {"extensions": {}})
        self.assertEqual(meta[main.CLIENT_INFO_KEY], main.CLIENT_INFO)

    def test_modern_discovery_never_initializes(self) -> None:
        server = main.ModernFakeServer("modern", [make_tool("search")])
        client = main.MultiServerClient()
        client.add_server("modern", server)
        client.connect_all()
        self.assertEqual(client.peers["modern"].era, "modern")
        self.assertEqual([message["method"] for message in server.received], ["server/discover"])

    def test_unsupported_version_retries_modern(self) -> None:
        server = main.ModernFakeServer("modern", [make_tool("search")])
        client = main.MultiServerClient(
            supported_modern=("2027-01-01", main.PROTOCOL_VERSION),
            probe_version="2027-01-01",
        )
        client.add_server("modern", server)
        client.connect_all()
        methods = [message["method"] for message in server.received]
        versions = [message["params"]["_meta"][main.VERSION_KEY] for message in server.received]
        self.assertEqual(methods, ["server/discover", "server/discover"])
        self.assertEqual(versions, ["2027-01-01", main.PROTOCOL_VERSION])
        self.assertNotIn("initialize", methods)

    def test_recognized_modern_error_does_not_fall_back(self) -> None:
        received = []

        def header_error(message: dict) -> dict:
            received.append(message)
            return main.rpc_error(message.get("id"), -32020, "Header mismatch")

        client = main.MultiServerClient()
        client.add_server("broken-modern", header_error)
        with self.assertRaises(RuntimeError):
            client.connect_all()
        self.assertEqual([message["method"] for message in received], ["server/discover"])

    def test_unrecognized_probe_error_selects_legacy(self) -> None:
        server = main.LegacyFakeServer("legacy", [make_tool("search")])
        client = main.MultiServerClient()
        client.add_server("legacy", server)
        client.connect_all()
        methods = [message["method"] for message in server.received]
        self.assertEqual(client.peers["legacy"].era, "legacy")
        self.assertEqual(methods, ["server/discover", "initialize", "notifications/initialized"])

    def test_merge_is_deterministic_and_prefixes_collisions(self) -> None:
        alpha = main.ModernFakeServer("alpha", [make_tool("search"), make_tool("write")])
        beta = main.ModernFakeServer("beta", [make_tool("read"), make_tool("search")])
        client = main.MultiServerClient()
        client.add_server("beta", beta)
        client.add_server("alpha", alpha)
        client.connect_all()
        client.discover_tools()
        client.merge()
        self.assertEqual(list(client.registry), ["beta/search", "read", "search", "write"])
        self.assertEqual(client.registry["search"].peer_name, "alpha")

    def test_modern_tool_call_repeats_metadata(self) -> None:
        server = main.ModernFakeServer("modern", [make_tool("search")])
        client = main.MultiServerClient()
        client.add_server("modern", server)
        client.connect_all()
        client.discover_tools()
        client.merge()
        result = client.call("search", {})
        call = server.received[-1]
        self.assertEqual(result["resultType"], "complete")
        self.assertEqual(call["method"], "tools/call")
        self.assertEqual(call["params"]["_meta"][main.VERSION_KEY], main.PROTOCOL_VERSION)

    def test_legacy_result_is_normalized_internally(self) -> None:
        server = main.LegacyFakeServer("legacy", [make_tool("search")])
        client = main.MultiServerClient()
        client.add_server("legacy", server)
        client.connect_all()
        client.discover_tools()
        client.merge()
        result = client.call("search", {})
        self.assertEqual(result["resultType"], "complete")


if __name__ == "__main__":
    unittest.main()
