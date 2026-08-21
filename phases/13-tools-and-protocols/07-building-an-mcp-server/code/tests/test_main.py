import unittest

import main


class McpServerTests(unittest.TestCase):
    def setUp(self) -> None:
        main.reset_notes()

    def test_discover_is_mandatory_modern_shape(self) -> None:
        response = main.dispatch(main.make_request(1, "server/discover"))
        result = response["result"]
        self.assertEqual(result["supportedVersions"], [main.PROTOCOL_VERSION])
        self.assertEqual(result["resultType"], "complete")
        self.assertEqual(result["cacheScope"], "public")

    def test_missing_request_meta_is_invalid_params(self) -> None:
        message = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        response = main.dispatch(message)
        self.assertEqual(response["error"]["code"], -32602)

    def test_unsupported_version_is_modern_error(self) -> None:
        response = main.dispatch(main.make_request(3, "tools/list", version="2027-01-01"))
        self.assertEqual(response["error"]["code"], -32022)
        self.assertEqual(response["error"]["data"]["supported"], [main.PROTOCOL_VERSION])

    def test_all_list_results_are_sorted_and_cacheable(self) -> None:
        for request_id, method, key in (
            (4, "tools/list", "tools"),
            (5, "resources/list", "resources"),
            (6, "prompts/list", "prompts"),
        ):
            result = main.dispatch(main.make_request(request_id, method))["result"]
            field = "uri" if key == "resources" else "name"
            values = [item[field] for item in result[key]]
            self.assertEqual(values, sorted(values))
            self.assertIn("ttlMs", result)
            self.assertIn(result["cacheScope"], {"private", "public"})

    def test_every_success_has_server_identity(self) -> None:
        for request_id, method in ((7, "tools/list"), (8, "resources/list"), (9, "prompts/list")):
            result = main.dispatch(main.make_request(request_id, method))["result"]
            self.assertEqual(result["resultType"], "complete")
            self.assertEqual(result["_meta"][main.SERVER_INFO_KEY], main.SERVER_INFO)

    def test_create_then_read_returns_private_cacheable_resource(self) -> None:
        create = main.dispatch(
            main.make_request(
                10,
                "tools/call",
                {"name": "notes_create", "arguments": {"title": "New", "body": "Body"}},
            )
        )["result"]
        uri = create["content"][1]["resource"]["uri"]
        read = main.dispatch(main.make_request(11, "resources/read", {"uri": uri}))["result"]
        self.assertEqual(read["resultType"], "complete")
        self.assertEqual(read["cacheScope"], "private")
        self.assertIn("Body", read["contents"][0]["text"])

    def test_unknown_tool_is_tool_level_error(self) -> None:
        result = main.dispatch(
            main.make_request(12, "tools/call", {"name": "missing", "arguments": {}})
        )["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(result["resultType"], "complete")

    def test_initialize_is_not_a_modern_handler(self) -> None:
        response = main.dispatch(main.make_request(13, "initialize"))
        self.assertEqual(response["error"]["code"], -32601)


if __name__ == "__main__":
    unittest.main()
