"""Phase 13 Lesson 16: MCP 2026-07-28 authorization simulator.

Companion to ../docs/en.md. Implements an in-process protocol model with
protected-resource discovery, CIMD-first enrollment, deprecated DCR fallback,
PKCE, issuer validation, resource-bound tokens, scope step-up, discovery, and
tools/list. Lesson 09 supplies the complete Streamable HTTP adapter.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse


PROTOCOL_VERSION = "2026-07-28"
PROTOCOL_META = "io.modelcontextprotocol/protocolVersion"
CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"
CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo"
SERVER_INFO_META = "io.modelcontextprotocol/serverInfo"
RESOURCE = "https://notes.example.com/mcp"
RESOURCE_METADATA_URI = "https://notes.example.com/.well-known/oauth-protected-resource/mcp"
ISSUER = "https://auth.example.com"
CLIENT_METADATA_URL = "https://client.example.com/oauth/metadata.json"
SERVER_INFO = {"name": "notes-server", "version": "2.0.0"}

TOOL_DESCRIPTORS = [
    {
        "name": "notes.create",
        "description": "Create a note.",
        "inputSchema": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
        },
    },
    {
        "name": "notes.delete",
        "description": "Delete a note by identifier.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    },
    {
        "name": "notes.list",
        "description": "List notes visible to the principal.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


@dataclass(frozen=True)
class Token:
    value: str
    issuer: str
    audience: str
    subject: str
    client_id: str
    scopes: frozenset[str]
    expires_at: float


@dataclass(frozen=True)
class ProtocolError(Exception):
    code: int
    message: str
    data: dict[str, Any] | None = None
    http_status: int = 400
    headers: dict[str, str] | None = None


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(32)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def request_meta() -> dict[str, Any]:
    return {
        PROTOCOL_META: PROTOCOL_VERSION,
        CLIENT_CAPABILITIES_META: {},
        CLIENT_INFO_META: {"name": "oauth-lesson-client", "version": "1.0.0"},
    }


def make_mcp_request(request_id: int, tool: str, arguments: dict[str, Any] | None = None):
    params = {"name": tool, "arguments": dict(arguments or {}), "_meta": request_meta()}
    body = {"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": params}
    headers = {
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
    }
    return body, headers


def make_discover_request(request_id: int = 0):
    body = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "server/discover",
        "params": {"_meta": request_meta()},
    }
    headers = {
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "server/discover",
    }
    return body, headers


def make_tools_list_request(request_id: int = 0):
    body = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/list",
        "params": {"_meta": request_meta()},
    }
    headers = {
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "tools/list",
    }
    return body, headers


@dataclass
class AuthorizationServer:
    issuer: str = ISSUER
    supports_cimd: bool = True
    supports_dcr: bool = True
    clients: dict[str, dict[str, Any]] = field(default_factory=dict)
    pending_codes: dict[str, dict[str, Any]] = field(default_factory=dict)

    def metadata(self) -> dict[str, Any]:
        metadata = {
            "issuer": self.issuer,
            "authorization_endpoint": f"{self.issuer}/authorize",
            "token_endpoint": f"{self.issuer}/token",
            "code_challenge_methods_supported": ["S256"],
            "authorization_response_iss_parameter_supported": True,
            "client_id_metadata_document_supported": self.supports_cimd,
        }
        if self.supports_dcr:
            metadata["registration_endpoint"] = f"{self.issuer}/register"
        return metadata

    @staticmethod
    def _validate_application(metadata: dict[str, Any], *, require_application_type: bool) -> None:
        application_type = metadata.get("application_type")
        if require_application_type and application_type not in {"native", "web"}:
            raise ValueError("application_type must be native or web")
        if application_type is not None and application_type not in {"native", "web"}:
            raise ValueError("application_type must be native or web")
        redirect_uris = metadata.get("redirect_uris")
        if not isinstance(redirect_uris, list) or not redirect_uris:
            raise ValueError("redirect_uris is required")
        if application_type == "web":
            for redirect_uri in redirect_uris:
                parsed = urlparse(redirect_uri)
                if parsed.scheme != "https" or parsed.hostname in {"localhost", "127.0.0.1"}:
                    raise ValueError("web redirect URIs must use remote HTTPS")

    def enroll_cimd(self, metadata_url: str, document: dict[str, Any]) -> str:
        if not self.supports_cimd:
            raise ValueError("CIMD is not supported")
        parsed = urlparse(metadata_url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.path in {"", "/"}:
            raise ValueError("CIMD client_id must be an HTTPS URL with a path")
        if document.get("client_id") != metadata_url:
            raise ValueError("CIMD client_id must equal its metadata URL")
        if not isinstance(document.get("client_name"), str) or not document["client_name"]:
            raise ValueError("client_name is required")
        self._validate_application(document, require_application_type=False)
        self.clients[metadata_url] = {**document, "enrollment": "cimd"}
        return metadata_url

    def dynamic_register(self, metadata: dict[str, Any]) -> str:
        if not self.supports_dcr:
            raise ValueError("DCR is not supported")
        self._validate_application(metadata, require_application_type=True)
        client_id = f"dcr_{secrets.token_hex(6)}"
        self.clients[client_id] = {**metadata, "enrollment": "dcr-compatibility"}
        return client_id

    def authorize(
        self,
        *,
        client_id: str,
        redirect_uri: str,
        subject: str,
        scopes: set[str],
        challenge: str,
        resource: str,
    ) -> dict[str, str]:
        client = self.clients.get(client_id)
        if client is None or redirect_uri not in client["redirect_uris"]:
            raise ValueError("unknown client or redirect URI")
        code = f"code_{secrets.token_hex(8)}"
        self.pending_codes[code] = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "subject": subject,
            "scopes": frozenset(scopes),
            "challenge": challenge,
            "resource": resource,
            "expires_at": time.time() + 300,
        }
        return {"code": code, "iss": self.issuer}

    def exchange(
        self,
        *,
        code: str,
        verifier: str,
        redirect_uri: str,
        resource: str,
    ) -> Token:
        record = self.pending_codes.pop(code, None)
        if record is None or record["expires_at"] < time.time():
            raise ValueError("invalid authorization code")
        if record["redirect_uri"] != redirect_uri or record["resource"] != resource:
            raise ValueError("redirect_uri or resource mismatch")
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        if not secrets.compare_digest(challenge, record["challenge"]):
            raise ValueError("PKCE mismatch")
        return Token(
            value=f"tok_{secrets.token_hex(12)}",
            issuer=self.issuer,
            audience=resource,
            subject=record["subject"],
            client_id=record["client_id"],
            scopes=record["scopes"],
            expires_at=time.time() + 3600,
        )


@dataclass
class ResourceServer:
    resource: str = RESOURCE
    issuer: str = ISSUER
    scopes: dict[str, str] = field(default_factory=lambda: {
        "notes.list": "notes:read",
        "notes.create": "notes:write",
        "notes.delete": "notes:delete",
    })

    def protected_resource_metadata(self) -> dict[str, Any]:
        return {
            "resource": self.resource,
            "authorization_servers": [self.issuer],
            "scopes_supported": sorted(set(self.scopes.values())),
        }

    @staticmethod
    def _success(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        payload = dict(result)
        payload.setdefault("resultType", "complete")
        payload.setdefault("_meta", {})[SERVER_INFO_META] = SERVER_INFO
        return {"jsonrpc": "2.0", "id": request_id, "result": payload}

    @staticmethod
    def _error(request_id: Any, error: ProtocolError) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": error.code, "message": error.message}
        if error.data is not None:
            payload["data"] = error.data
        return {"jsonrpc": "2.0", "id": request_id, "error": payload}

    @staticmethod
    def _validate_wire(body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        if body.get("jsonrpc") != "2.0":
            raise ProtocolError(-32600, "Invalid Request")
        method = body.get("method")
        params = body.get("params")
        if not isinstance(method, str) or not isinstance(params, dict):
            raise ProtocolError(-32600, "Invalid Request")
        meta = params.get("_meta") if isinstance(params, dict) else None
        if not isinstance(meta, dict):
            raise ProtocolError(-32602, "params._meta must be an object")
        requested_version = meta.get(PROTOCOL_META)
        if not isinstance(requested_version, str):
            raise ProtocolError(-32602, "protocolVersion must be a string")
        if not isinstance(meta.get(CLIENT_CAPABILITIES_META), dict):
            raise ProtocolError(-32602, "clientCapabilities must be an object")
        if headers.get("MCP-Protocol-Version") != requested_version:
            raise ProtocolError(-32020, "MCP-Protocol-Version header mismatch")
        if headers.get("Mcp-Method") != method:
            raise ProtocolError(-32020, "Mcp-Method header mismatch")
        if method in {"tools/call", "resources/read", "prompts/get"}:
            expected_name = params.get("name") or params.get("uri")
            if headers.get("Mcp-Name") != expected_name:
                raise ProtocolError(-32020, "Mcp-Name header mismatch")
        if requested_version != PROTOCOL_VERSION:
            raise ProtocolError(
                -32022,
                "Unsupported protocol version",
                {"supported": [PROTOCOL_VERSION], "requested": requested_version},
            )
        return params

    def discover(
        self,
        body: dict[str, Any],
        headers: dict[str, str],
        *,
        http_method: str = "POST",
    ) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        return self.handle(body, headers, None, http_method=http_method)

    def call(
        self,
        body: dict[str, Any],
        headers: dict[str, str],
        token: Token | None,
        *,
        http_method: str = "POST",
    ) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        return self.handle(body, headers, token, http_method=http_method)

    def handle(
        self,
        body: dict[str, Any],
        headers: dict[str, str],
        token: Token | None = None,
        *,
        http_method: str = "POST",
    ) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        is_notification = "id" not in body
        try:
            if http_method != "POST":
                raise ProtocolError(-32600, "HTTP method not allowed", http_status=405)
            params = self._validate_wire(body, headers)
            method = body["method"]
            if method == "server/discover":
                result = {
                    "supportedVersions": [PROTOCOL_VERSION],
                    "capabilities": {"tools": {"listChanged": False}},
                    "ttlMs": 60_000,
                    "cacheScope": "public",
                }
            elif method == "tools/list":
                result = {
                    "tools": sorted(TOOL_DESCRIPTORS, key=lambda tool: tool["name"]),
                    "ttlMs": 60_000,
                    "cacheScope": "public",
                }
            elif method == "tools/call":
                challenge_base = f'Bearer resource_metadata="{RESOURCE_METADATA_URI}"'
                challenge_headers = {"WWW-Authenticate": challenge_base}
                if token is None or token.expires_at < time.time():
                    raise ProtocolError(
                        -32001,
                        "Unauthorized",
                        {"reason": "invalid_token"},
                        401,
                        challenge_headers,
                    )
                if token.issuer != self.issuer or token.audience != self.resource:
                    raise ProtocolError(
                        -32001,
                        "Unauthorized",
                        {"reason": "invalid_token"},
                        401,
                        challenge_headers,
                    )
                required = self.scopes.get(params.get("name"))
                if required is None:
                    raise ProtocolError(
                        -32602,
                        "Unknown tool",
                        {"name": params.get("name")},
                        404,
                    )
                if required not in token.scopes:
                    challenge = f'{challenge_base}, error="insufficient_scope", scope="{required}"'
                    raise ProtocolError(
                        -32003,
                        "Insufficient scope",
                        {"requiredScope": required},
                        403,
                        {"WWW-Authenticate": challenge},
                    )
                result = {
                    "content": [{
                        "type": "text",
                        "text": f"{params['name']} allowed for {token.subject}",
                    }],
                    "isError": False,
                }
            else:
                raise ProtocolError(-32601, "Method not found", http_status=404)
            if is_notification:
                return 202, None, {}
            return 200, self._success(body["id"], result), {}
        except ProtocolError as error:
            if is_notification:
                return error.http_status, None, dict(error.headers or {})
            return (
                error.http_status,
                self._error(body.get("id"), error),
                dict(error.headers or {}),
            )


class Client:
    def __init__(self, *, subject: str = "alice", application_type: str = "native") -> None:
        self.subject = subject
        self.application_type = application_type
        self.redirect_uri = "http://127.0.0.1:8765/callback" if application_type == "native" else "https://client.example.com/callback"
        self.client_ids_by_issuer: dict[str, str] = {}
        self.tokens_by_issuer_resource: dict[tuple[str, str], Token] = {}
        self.next_request_id = 1

    def _client_document(self) -> dict[str, Any]:
        return {
            "client_id": CLIENT_METADATA_URL,
            "client_name": "OAuth lesson client",
            "application_type": self.application_type,
            "redirect_uris": [self.redirect_uri],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
        }

    def enroll(self, auth: AuthorizationServer) -> str:
        metadata = auth.metadata()
        if metadata.get("issuer") != auth.issuer:
            raise ValueError("authorization metadata issuer mismatch")
        if metadata.get("client_id_metadata_document_supported"):
            client_id = auth.enroll_cimd(CLIENT_METADATA_URL, self._client_document())
        elif metadata.get("registration_endpoint"):
            fallback = self._client_document()
            fallback.pop("client_id")
            client_id = auth.dynamic_register(fallback)
        else:
            raise ValueError("authorization server offers no supported client enrollment")
        self.client_ids_by_issuer[auth.issuer] = client_id
        return client_id

    def authorize(self, auth: AuthorizationServer, resource: str, scopes: set[str]) -> Token:
        client_id = self.client_ids_by_issuer.get(auth.issuer)
        if client_id is None:
            client_id = self.enroll(auth)
        verifier, challenge = pkce_pair()
        response = auth.authorize(
            client_id=client_id,
            redirect_uri=self.redirect_uri,
            subject=self.subject,
            scopes=scopes,
            challenge=challenge,
            resource=resource,
        )
        if response.get("iss") != auth.issuer:
            raise ValueError("authorization response issuer mismatch")
        token = auth.exchange(
            code=response["code"],
            verifier=verifier,
            redirect_uri=self.redirect_uri,
            resource=resource,
        )
        self.tokens_by_issuer_resource[(auth.issuer, resource)] = token
        return token

    def call_with_step_up(
        self,
        tool: str,
        server: ResourceServer,
        auth: AuthorizationServer,
    ) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
        if server.issuer != auth.issuer:
            raise ValueError("protected resource selected a different issuer")
        key = (auth.issuer, server.resource)
        token = self.tokens_by_issuer_resource.get(key)
        if token is None:
            token = self.authorize(auth, server.resource, {"notes:read"})
        body, headers = make_mcp_request(self.next_request_id, tool)
        self.next_request_id += 1
        status, response, response_headers = server.call(body, headers, token)
        if status == 403 and response is not None and response.get("error", {}).get("code") == -32003:
            required = response_headers["WWW-Authenticate"].split('scope="', 1)[1].split('"', 1)[0]
            token = self.authorize(auth, server.resource, set(token.scopes) | {required})
            body, headers = make_mcp_request(self.next_request_id, tool)
            self.next_request_id += 1
            status, response, response_headers = server.call(body, headers, token)
        return status, response, response_headers


def demo() -> None:
    auth = AuthorizationServer()
    server = ResourceServer()
    client = Client()
    discover_body, discover_headers = make_discover_request()
    _, discovery, _ = server.discover(discover_body, discover_headers)
    print("server discovery:", discovery["result"] if discovery else None)
    list_body, list_headers = make_tools_list_request()
    _, listing, _ = server.handle(list_body, list_headers)
    print("tools:", [tool["name"] for tool in listing["result"]["tools"]] if listing else None)
    print("protected resource metadata:", server.protected_resource_metadata())
    print("CIMD client_id:", client.enroll(auth))
    for tool in ("notes.list", "notes.create", "notes.delete"):
        status, response, _ = client.call_with_step_up(tool, server, auth)
        print(tool, status, response.get("result", {}).get("content") if response else None)
    print("effective client ids by issuer:", sorted(client.client_ids_by_issuer))


if __name__ == "__main__":
    demo()
