"""Phase 13 Lesson 12: explicit scope and elicitation through MRTR.

Lesson: ../docs/en.md
Specification: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
This example uses only Python's standard library.
Run: python3 main.py
"""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import posixpath
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlparse


PROTOCOL_VERSION = "2026-07-28"
PROTOCOL_META = "io.modelcontextprotocol/protocolVersion"
CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"
CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo"
SERVER_INFO_META = "io.modelcontextprotocol/serverInfo"
SERVER_SECRET = b"lesson-12-demo-secret-change-in-production"

DEFAULT_NOTES = {
    "note-3": {
        "title": "TPS report 2023",
        "uri": "file:///Users/alice/Documents/Notes/tps-2023.md",
    },
    "note-7": {
        "title": "TPS report 2024",
        "uri": "file:///Users/alice/Documents/Notes/tps-2024.md",
    },
    "note-14": {
        "title": "TPS report 2025",
        "uri": "file:///Users/alice/Documents/Notes/tps-2025.md",
    },
    "note-99": {
        "title": "shopping list",
        "uri": "file:///Users/alice/Documents/Notes/shopping.md",
    },
    "note-100": {
        "title": "outside root",
        "uri": "file:///tmp/outside.md",
    },
}
TOOLS = [
    {
        "name": "notes_delete",
        "description": "Delete one authorized note after explicit user confirmation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspaceUri": {"type": "string", "format": "uri"},
                "title": {"type": "string", "minLength": 1},
            },
            "required": ["workspaceUri", "title"],
        },
    }
]


@dataclass
class McpError(Exception):
    code: int
    message: str
    data: dict[str, Any] | None = None


def request_meta(*, elicitation: bool = True) -> dict[str, Any]:
    capabilities: dict[str, Any] = (
        {"elicitation": {"form": {}}} if elicitation else {}
    )
    return {
        PROTOCOL_META: PROTOCOL_VERSION,
        CAPABILITIES_META: capabilities,
        CLIENT_INFO_META: {"name": "lesson-client", "version": "1.0.0"},
    }


def _server_meta() -> dict[str, Any]:
    return {SERVER_INFO_META: {"name": "explicit-scope-demo", "version": "1.0.0"}}


def complete(**fields: Any) -> dict[str, Any]:
    return {"resultType": "complete", **fields, "_meta": _server_meta()}


def validate_request_meta(params: dict[str, Any]) -> dict[str, Any]:
    meta = params.get("_meta")
    if not isinstance(meta, dict):
        raise McpError(-32602, "missing request _meta")
    requested_version = meta.get(PROTOCOL_META)
    if not isinstance(requested_version, str):
        raise McpError(-32602, "missing protocol version")
    if requested_version != PROTOCOL_VERSION:
        raise McpError(
            -32022,
            "unsupported protocol version",
            {"supported": [PROTOCOL_VERSION], "requested": requested_version},
        )
    capabilities = meta.get(CAPABILITIES_META)
    if not isinstance(capabilities, dict):
        raise McpError(-32602, "missing client capabilities")
    return meta


def supports_form_elicitation(capabilities: dict[str, Any]) -> bool:
    elicitation = capabilities.get("elicitation")
    if not isinstance(elicitation, dict):
        return False
    if not elicitation:
        return True
    return isinstance(elicitation.get("form"), dict)


def _normalized_uri_parts(uri: str) -> tuple[str, str, str]:
    parsed = urlparse(uri)
    if parsed.scheme != "file" or parsed.query or parsed.fragment:
        raise ValueError("only plain file URIs are supported")
    path = posixpath.normpath(unquote(parsed.path))
    if not path.startswith("/"):
        raise ValueError("file URI path must be absolute")
    return parsed.scheme, parsed.netloc, path


def uri_within_workspace(workspace_uri: str, candidate_uri: str) -> bool:
    try:
        workspace_scheme, workspace_host, workspace_path = _normalized_uri_parts(
            workspace_uri
        )
        candidate_scheme, candidate_host, candidate_path = _normalized_uri_parts(
            candidate_uri
        )
        if (workspace_scheme, workspace_host) != (candidate_scheme, candidate_host):
            return False
        return posixpath.commonpath([workspace_path, candidate_path]) == workspace_path
    except (ValueError, TypeError):
        return False


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _arguments_digest(arguments: dict[str, Any]) -> str:
    encoded = json.dumps(arguments, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def seal_request_state(payload: dict[str, Any]) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    signature = hmac.new(SERVER_SECRET, body, hashlib.sha256).digest()
    return f"{_b64(body)}.{_b64(signature)}"


def verify_request_state(
    token: str,
    *,
    principal: str,
    arguments: dict[str, Any],
    now: int | None = None,
) -> dict[str, Any]:
    try:
        body_part, signature_part = token.split(".", 1)
        body = _unb64(body_part)
        supplied = _unb64(signature_part)
    except (ValueError, TypeError) as exc:
        raise McpError(-32602, "invalid requestState encoding") from exc
    expected = hmac.new(SERVER_SECRET, body, hashlib.sha256).digest()
    if not hmac.compare_digest(supplied, expected):
        raise McpError(-32602, "requestState integrity check failed")
    try:
        state = json.loads(body)
    except json.JSONDecodeError as exc:
        raise McpError(-32602, "invalid requestState payload") from exc
    if state.get("principal") != principal:
        raise McpError(-32602, "requestState principal mismatch")
    if state.get("method") != "tools/call":
        raise McpError(-32602, "requestState method mismatch")
    if state.get("argumentsDigest") != _arguments_digest(arguments):
        raise McpError(-32602, "requestState arguments mismatch")
    if int(state.get("expiresAt", 0)) < (int(time.time()) if now is None else now):
        raise McpError(-32602, "requestState expired")
    return state


class NotesServer:
    def __init__(self) -> None:
        self.notes = copy.deepcopy(DEFAULT_NOTES)
        self.authorized_workspaces = {"file:///Users/alice/Documents/Notes"}

    def server_discover(self, params: dict[str, Any]) -> dict[str, Any]:
        validate_request_meta(params)
        return complete(
            supportedVersions=[PROTOCOL_VERSION],
            capabilities={"tools": {}},
            ttlMs=300_000,
            cacheScope="public",
        )

    def tools_list(self, params: dict[str, Any]) -> dict[str, Any]:
        validate_request_meta(params)
        return complete(
            tools=sorted(TOOLS, key=lambda tool: tool["name"]),
            ttlMs=60_000,
            cacheScope="public",
        )

    def _require_authorized_workspace(self, workspace_uri: Any) -> str:
        if not isinstance(workspace_uri, str):
            raise McpError(-32602, "workspaceUri must be a string")
        if workspace_uri not in self.authorized_workspaces:
            raise McpError(-32602, "workspace is not authorized")
        return workspace_uri

    def _elicitation_result(
        self,
        *,
        candidates: list[dict[str, Any]],
        principal: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        candidate_ids = [candidate["id"] for candidate in candidates]
        state = {
            "phase": "confirm_delete",
            "principal": principal,
            "method": "tools/call",
            "argumentsDigest": _arguments_digest(arguments),
            "candidateIds": candidate_ids,
            "expiresAt": int(time.time()) + 300,
        }
        return {
            "resultType": "input_required",
            "inputRequests": {
                "delete_choice": {
                    "method": "elicitation/create",
                    "params": {
                        "mode": "form",
                        "message": "Choose one matching note and confirm deletion.",
                        "requestedSchema": {
                            "type": "object",
                            "properties": {
                                "note_id": {"type": "string", "enum": candidate_ids},
                                "confirm": {"type": "boolean"},
                            },
                            "required": ["note_id", "confirm"],
                        },
                    },
                }
            },
            "requestState": seal_request_state(state),
            "_meta": _server_meta(),
        }

    def tools_call(self, params: dict[str, Any], *, principal: str) -> dict[str, Any]:
        meta = validate_request_meta(params)
        if params.get("name") != "notes_delete":
            raise McpError(-32602, "unknown tool")
        arguments = params.get("arguments")
        if not isinstance(arguments, dict):
            raise McpError(-32602, "arguments must be an object")
        workspace_uri = self._require_authorized_workspace(arguments.get("workspaceUri"))
        title = arguments.get("title")
        if not isinstance(title, str) or not title.strip():
            raise McpError(-32602, "title must be a non-empty string")

        capabilities = meta[CAPABILITIES_META]
        if not supports_form_elicitation(capabilities):
            raise McpError(
                -32021,
                "missing required client capability",
                {"requiredCapabilities": {"elicitation": {"form": {}}}},
            )

        state_token = params.get("requestState")
        if state_token is None:
            candidates = [
                {"id": note_id, **note}
                for note_id, note in self.notes.items()
                if title.lower() in note["title"].lower()
                and uri_within_workspace(workspace_uri, note["uri"])
            ]
            if not candidates:
                return complete(
                    content=[{"type": "text", "text": "no match in authorized workspace"}],
                    isError=True,
                )
            return self._elicitation_result(
                candidates=candidates,
                principal=principal,
                arguments=arguments,
            )

        if not isinstance(state_token, str):
            raise McpError(-32602, "requestState must be a string")
        state = verify_request_state(
            state_token,
            principal=principal,
            arguments=arguments,
        )
        if state.get("phase") != "confirm_delete":
            raise McpError(-32602, "unknown requestState phase")
        responses = params.get("inputResponses")
        if not isinstance(responses, dict):
            raise McpError(-32602, "inputResponses must be an object")
        answer = responses.get("delete_choice")
        if not isinstance(answer, dict):
            raise McpError(-32602, "missing delete_choice response")
        action = answer.get("action")
        if action in {"decline", "cancel"}:
            return complete(
                content=[{"type": "text", "text": "deletion cancelled"}],
                structuredContent={"deleted": False},
                isError=False,
            )
        if action != "accept" or not isinstance(answer.get("content"), dict):
            raise McpError(-32602, "invalid elicitation response")
        content = answer["content"]
        note_id = content.get("note_id")
        if content.get("confirm") is not True or note_id not in state["candidateIds"]:
            raise McpError(-32602, "invalid deletion confirmation")
        note = self.notes.get(note_id)
        if note is None:
            raise McpError(-32602, "selected note no longer exists")
        if not uri_within_workspace(workspace_uri, note["uri"]):
            raise McpError(-32602, "selected note is outside workspace")
        del self.notes[note_id]
        return complete(
            content=[{"type": "text", "text": f"deleted {note_id}"}],
            structuredContent={"deleted": True, "noteId": note_id},
            isError=False,
        )

    def dispatch(
        self,
        request: dict[str, Any],
        *,
        principal: str = "user-42",
    ) -> dict[str, Any] | None:
        is_notification = "id" not in request
        request_id = request.get("id")
        try:
            params = request.get("params", {})
            if not isinstance(params, dict):
                raise McpError(-32602, "params must be an object")
            method = request.get("method")
            if method == "server/discover":
                result = self.server_discover(params)
            elif method == "tools/list":
                result = self.tools_list(params)
            elif method == "tools/call":
                result = self.tools_call(params, principal=principal)
            else:
                raise McpError(-32601, "method not found")
            if is_notification:
                return None
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except McpError as exc:
            if is_notification:
                return None
            error: dict[str, Any] = {"code": exc.code, "message": exc.message}
            if exc.data is not None:
                error["data"] = exc.data
            return {"jsonrpc": "2.0", "id": request_id, "error": error}


def tool_request(request_id: int, title: str = "TPS report") -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": "notes_delete",
            "arguments": {
                "workspaceUri": "file:///Users/alice/Documents/Notes",
                "title": title,
            },
            "_meta": request_meta(),
        },
    }


def run_mrtr(*, action: str = "accept") -> tuple[NotesServer, dict[str, Any], list[int]]:
    server = NotesServer()
    first = server.dispatch(tool_request(1))
    input_request = first["result"]["inputRequests"]["delete_choice"]
    choices = input_request["params"]["requestedSchema"]["properties"]["note_id"]["enum"]
    content = {"note_id": choices[-1], "confirm": True} if action == "accept" else {}
    retry = tool_request(2)
    retry["params"].update(
        {
            "inputResponses": {
                "delete_choice": {"action": action, "content": content}
            },
            "requestState": first["result"]["requestState"],
        }
    )
    final = server.dispatch(retry)
    return server, final, [1, 2]


def main() -> None:
    server = NotesServer()
    discovery = server.dispatch(
        {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "server/discover",
            "params": {"_meta": request_meta()},
        }
    )
    print("discover:", json.dumps(discovery["result"], indent=2))
    server, final, request_ids = run_mrtr()
    print("independent request ids:", request_ids)
    print("final:", json.dumps(final["result"], indent=2))
    print("remaining note ids:", sorted(server.notes))


if __name__ == "__main__":
    main()
