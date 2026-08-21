"""Phase 13 Lesson 08: a stateless multi-server MCP client.
Lesson: phases/13-tools-and-protocols/08-building-an-mcp-client/docs/en.md
Specification: https://modelcontextprotocol.io/specification/2026-07-28/
Demonstrates discovery, recognized-error handling, legacy fallback, and routing.
Run: python3 main.py
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable


PROTOCOL_VERSION = "2026-07-28"
LEGACY_VERSION = "2025-11-25"
VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities"
CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
RECOGNIZED_MODERN_ERRORS = {-32020, -32021, -32022}

CLIENT_INFO = {"name": "lesson-08-client", "version": "2.0.0"}
CLIENT_CAPABILITIES: dict[str, Any] = {"extensions": {}}

Transport = Callable[[dict[str, Any]], dict[str, Any] | None]


class RpcFault(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data


def request_meta(
    version: str,
    capabilities: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        VERSION_KEY: version,
        CAPABILITIES_KEY: CLIENT_CAPABILITIES.copy() if capabilities is None else capabilities,
        CLIENT_INFO_KEY: CLIENT_INFO.copy(),
    }


def modern_request(
    request_id: int | str,
    method: str,
    params: dict[str, Any] | None,
    version: str,
    capabilities: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body_params = dict(params or {})
    body_params["_meta"] = request_meta(version, capabilities)
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": body_params}


def legacy_request(
    request_id: int | str,
    method: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params or {})}


def rpc_error(
    request_id: int | str | None,
    code: int,
    message: str,
    data: Any | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def complete(
    server_info: dict[str, str],
    payload: dict[str, Any],
    *,
    ttl_ms: int | None = None,
    cache_scope: str = "private",
) -> dict[str, Any]:
    result = {
        "resultType": "complete",
        **payload,
        "_meta": {SERVER_INFO_KEY: server_info.copy()},
    }
    if ttl_ms is not None:
        result["ttlMs"] = ttl_ms
        result["cacheScope"] = cache_scope
    return result


def validate_modern_request(message: dict[str, Any], supported: list[str]) -> None:
    if message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
        raise RpcFault(-32600, "Invalid Request")
    params = message.get("params")
    if not isinstance(params, dict) or not isinstance(params.get("_meta"), dict):
        raise RpcFault(-32602, "Modern params._meta is required")
    meta = params["_meta"]
    requested = meta.get(VERSION_KEY)
    if not isinstance(requested, str):
        raise RpcFault(-32602, f"{VERSION_KEY} is required")
    if requested not in supported:
        raise RpcFault(
            -32022,
            "Unsupported protocol version",
            {"requested": requested, "supported": supported.copy()},
        )
    if not isinstance(meta.get(CAPABILITIES_KEY), dict):
        raise RpcFault(-32602, f"{CAPABILITIES_KEY} is required")


class ModernFakeServer:
    def __init__(
        self,
        name: str,
        tools: list[dict[str, Any]],
        capabilities: dict[str, Any] | None = None,
        supported_versions: list[str] | None = None,
    ) -> None:
        self.server_info = {"name": name, "version": "2.0.0"}
        self.tools = sorted(tools, key=lambda tool: tool["name"])
        self.capabilities = capabilities or {"tools": {"listChanged": False}}
        self.supported_versions = supported_versions or [PROTOCOL_VERSION]
        self.received: list[dict[str, Any]] = []

    def __call__(self, message: dict[str, Any]) -> dict[str, Any] | None:
        self.received.append(message)
        if "id" not in message:
            return None
        request_id = message["id"]
        try:
            validate_modern_request(message, self.supported_versions)
            method = message["method"]
            params = message["params"]
            if method == "server/discover":
                result = complete(
                    self.server_info,
                    {
                        "supportedVersions": self.supported_versions.copy(),
                        "capabilities": self.capabilities.copy(),
                        "instructions": f"Tools provided by {self.server_info['name']}.",
                    },
                    ttl_ms=3_600_000,
                    cache_scope="public",
                )
            elif method == "tools/list":
                result = complete(
                    self.server_info,
                    {"tools": self.tools.copy()},
                    ttl_ms=30_000,
                    cache_scope="public",
                )
            elif method == "tools/call":
                name = params.get("name")
                if not isinstance(name, str):
                    raise RpcFault(-32602, "tools/call requires name")
                declared = {tool["name"] for tool in self.tools}
                result = complete(
                    self.server_info,
                    {
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    f"[{self.server_info['name']}] {name} ran"
                                    if name in declared
                                    else f"Unknown tool: {name}"
                                ),
                            }
                        ],
                        "isError": name not in declared,
                    },
                )
            else:
                raise RpcFault(-32601, f"Method not found: {method}")
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except RpcFault as exc:
            return rpc_error(request_id, exc.code, str(exc), exc.data)


class LegacyFakeServer:
    def __init__(self, name: str, tools: list[dict[str, Any]]) -> None:
        self.name = name
        self.tools = sorted(tools, key=lambda tool: tool["name"])
        self.initialized = False
        self.received: list[dict[str, Any]] = []

    def __call__(self, message: dict[str, Any]) -> dict[str, Any] | None:
        self.received.append(message)
        method = message.get("method")
        if method == "server/discover":
            return rpc_error(message.get("id"), -32601, "Method not found")
        if method == "initialize":
            self.initialized = True
            return {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {
                    "protocolVersion": LEGACY_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": self.name, "version": "1.0.0"},
                },
            }
        if method == "notifications/initialized":
            return None
        if not self.initialized:
            return rpc_error(message.get("id"), -32002, "Server not initialized")
        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": message["id"], "result": {"tools": self.tools.copy()}}
        if method == "tools/call":
            name = message.get("params", {}).get("name")
            return {
                "jsonrpc": "2.0",
                "id": message["id"],
                "result": {
                    "content": [{"type": "text", "text": f"[{self.name}/legacy] {name} ran"}],
                    "isError": False,
                },
            }
        return rpc_error(message.get("id"), -32601, f"Method not found: {method}")


@dataclass
class Peer:
    name: str
    transport: Transport
    era: str = "unknown"
    protocol_version: str | None = None
    capabilities: dict[str, Any] = field(default_factory=dict)
    server_info: dict[str, Any] = field(default_factory=dict)
    tools: list[dict[str, Any]] = field(default_factory=list)
    available: bool = False


@dataclass(frozen=True)
class MergedTool:
    canonical_name: str
    peer_name: str
    local_name: str
    description: str


class MultiServerClient:
    def __init__(
        self,
        *,
        supported_modern: tuple[str, ...] = (PROTOCOL_VERSION,),
        probe_version: str | None = None,
    ) -> None:
        self.supported_modern = supported_modern
        self.probe_version = probe_version or supported_modern[0]
        self.client_capabilities = CLIENT_CAPABILITIES.copy()
        self.peers: dict[str, Peer] = {}
        self.registry: dict[str, MergedTool] = {}
        self._next_request_id = 1

    def _new_id(self) -> int:
        request_id = self._next_request_id
        self._next_request_id += 1
        return request_id

    def add_server(self, name: str, transport: Transport) -> None:
        self.peers[name] = Peer(name=name, transport=transport)

    def _mutual_version(self, advertised: list[Any]) -> str | None:
        common = [version for version in advertised if version in self.supported_modern]
        return sorted(common, reverse=True)[0] if common else None

    def _activate_modern(self, peer: Peer, result: dict[str, Any], version: str) -> None:
        if result.get("resultType") != "complete":
            raise RuntimeError(f"{peer.name}: modern discovery omitted resultType")
        peer.era = "modern"
        peer.protocol_version = version
        peer.capabilities = result.get("capabilities", {})
        peer.server_info = result.get("_meta", {}).get(SERVER_INFO_KEY, {})
        peer.available = True

    def _legacy_fallback(self, peer: Peer) -> None:
        initialize = legacy_request(
            self._new_id(),
            "initialize",
            {
                "protocolVersion": LEGACY_VERSION,
                "capabilities": self.client_capabilities.copy(),
                "clientInfo": CLIENT_INFO.copy(),
            },
        )
        response = peer.transport(initialize)
        if response is None or "result" not in response:
            raise RuntimeError(f"{peer.name}: legacy initialize failed")
        result = response["result"]
        peer.era = "legacy"
        peer.protocol_version = result["protocolVersion"]
        peer.capabilities = result.get("capabilities", {})
        peer.server_info = result.get("serverInfo", {})
        peer.available = True
        peer.transport(
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
        )

    def _connect_peer(self, peer: Peer) -> None:
        probe = modern_request(
            self._new_id(),
            "server/discover",
            {},
            self.probe_version,
            self.client_capabilities,
        )
        try:
            response = peer.transport(probe)
        except TimeoutError:
            self._legacy_fallback(peer)
            return

        if response is not None and "result" in response:
            advertised = response["result"].get("supportedVersions", [])
            selected = self._mutual_version(advertised)
            if selected is None:
                raise RuntimeError(f"{peer.name}: no mutually supported modern version")
            self._activate_modern(peer, response["result"], selected)
            return

        error = response.get("error", {}) if isinstance(response, dict) else {}
        code = error.get("code")
        if code in RECOGNIZED_MODERN_ERRORS:
            if code != -32022:
                raise RuntimeError(f"{peer.name}: correct modern request error {code} before retrying")
            selected = self._mutual_version(error.get("data", {}).get("supported", []))
            if selected is None:
                raise RuntimeError(f"{peer.name}: no mutually supported modern version")
            retry = modern_request(
                self._new_id(),
                "server/discover",
                {},
                selected,
                self.client_capabilities,
            )
            retried = peer.transport(retry)
            if retried is None or "result" not in retried:
                raise RuntimeError(f"{peer.name}: modern discovery retry failed")
            self._activate_modern(peer, retried["result"], selected)
            return

        self._legacy_fallback(peer)

    def connect_all(self) -> None:
        for peer_name in sorted(self.peers):
            self._connect_peer(self.peers[peer_name])

    def _request(self, peer: Peer, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._new_id()
        if peer.era == "modern":
            message = modern_request(
                request_id,
                method,
                params,
                peer.protocol_version or PROTOCOL_VERSION,
                self.client_capabilities,
            )
        elif peer.era == "legacy":
            message = legacy_request(request_id, method, params)
        else:
            raise RuntimeError(f"{peer.name}: protocol era not selected")
        response = peer.transport(message)
        if response is None or response.get("id") != request_id:
            raise RuntimeError(f"{peer.name}: missing or mismatched response")
        if "error" in response:
            raise RuntimeError(f"{peer.name}: RPC error {response['error']}")
        result = dict(response["result"])
        if peer.era == "modern" and "resultType" not in result:
            raise RuntimeError(f"{peer.name}: modern result omitted resultType")
        if peer.era == "legacy":
            result.setdefault("resultType", "complete")
        return result

    def discover_tools(self) -> None:
        for peer_name in sorted(self.peers):
            peer = self.peers[peer_name]
            if peer.available:
                result = self._request(peer, "tools/list", {})
                peer.tools = sorted(result.get("tools", []), key=lambda tool: tool["name"])

    def merge(self, policy: str = "prefix-on-collision") -> None:
        if policy not in {"prefix-on-collision", "reject"}:
            raise ValueError("policy must be prefix-on-collision or reject")
        self.registry.clear()
        for peer_name in sorted(self.peers):
            peer = self.peers[peer_name]
            for tool in peer.tools:
                local_name = tool["name"]
                canonical_name = local_name
                if canonical_name in self.registry:
                    if policy == "reject":
                        continue
                    canonical_name = f"{peer.name}/{local_name}"
                    if canonical_name in self.registry:
                        raise ValueError(f"canonical collision: {canonical_name}")
                self.registry[canonical_name] = MergedTool(
                    canonical_name=canonical_name,
                    peer_name=peer.name,
                    local_name=local_name,
                    description=tool.get("description", ""),
                )
        self.registry = dict(sorted(self.registry.items()))

    def call(self, canonical_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        merged = self.registry.get(canonical_name)
        if merged is None:
            return {
                "resultType": "complete",
                "content": [{"type": "text", "text": f"Unknown tool: {canonical_name}"}],
                "isError": True,
            }
        peer = self.peers[merged.peer_name]
        if not peer.available:
            return {
                "resultType": "complete",
                "content": [{"type": "text", "text": f"Transport unavailable: {peer.name}"}],
                "isError": True,
            }
        return self._request(
            peer,
            "tools/call",
            {"name": merged.local_name, "arguments": arguments},
        )


def tool(name: str, description: str) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    }


def main() -> None:
    notes = ModernFakeServer("notes", [tool("search", "Search notes"), tool("create", "Create note")])
    files = ModernFakeServer("files", [tool("search", "Search files"), tool("read", "Read file")])
    archive = LegacyFakeServer("archive", [tool("search", "Search archive"), tool("restore", "Restore item")])

    client = MultiServerClient()
    client.add_server("notes", notes)
    client.add_server("files", files)
    client.add_server("archive", archive)

    client.connect_all()
    client.discover_tools()
    client.merge()

    print("MCP client peers")
    for peer_name, peer in sorted(client.peers.items()):
        print(f"  {peer_name:8s} era={peer.era:6s} version={peer.protocol_version}")
    print("\nMerged tools")
    for canonical_name, merged in client.registry.items():
        print(f"  {canonical_name:20s} -> {merged.peer_name}:{merged.local_name}")
    print("\nCalls")
    for name in ("create", "read", "notes/search", "search", "restore"):
        result = client.call(name, {})
        print(f"  {name:20s} -> {result['content'][0]['text']}")
    print("\nNo modern protocol sessions were created.")


if __name__ == "__main__":
    main()
