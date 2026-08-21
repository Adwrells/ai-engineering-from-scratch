# MCP Fundamentals: Stateless Requests and JSON-RPC

> Modern MCP has no handshake and no protocol session. Each request must carry enough metadata to be understood, authorized, routed, and retried on its own.

**Type:** Learn
**Languages:** Python
**Prerequisites:** Phase 13, Lessons 01 through 05
**Time:** ~55 minutes

## Learning Objectives

- Distinguish MCP's server primitives from its client-side features.
- Build valid JSON-RPC 2.0 requests and responses for MCP `2026-07-28`.
- Attach protocol version, client capabilities, and client identity to every request.
- Use `server/discover` and handle `UnsupportedProtocolVersionError` without a handshake.
- Trace one independent request from validation through a complete result.

## The Problem

An MCP server can receive two consecutive requests from different clients, with different capabilities, on the same process or HTTP worker. If the server remembers what the previous request declared, it can apply the wrong permissions or return the wrong wire shape.

MCP `2026-07-28` removes that ambiguity. The protocol core is stateless. A server must decide how to handle the current request from the current request, not from connection history.

This changes the mental model. The old sequence was connection first, handshake second, operations third. The modern sequence is simpler:

1. The client sends a self-describing request.
2. The server validates that request's version and capabilities.
3. The server handles the method.
4. The server returns a typed result or a JSON-RPC error.

The next request repeats the same process from scratch.

## The Concept

### Server primitives

MCP servers expose three primary primitives:

1. **Tools** are model-controlled actions, discovered with `tools/list` and invoked with `tools/call`.
2. **Resources** are URI-addressed data, discovered with `resources/list` and retrieved with `resources/read`.
3. **Prompts** are reusable templates, discovered with `prompts/list` and rendered with `prompts/get`.

Roots, sampling, and logging remain in the `2026-07-28` schema for compatibility, but they are deprecated. New implementations should use explicit tool or resource inputs for roots, direct model-provider APIs for sampling, and stderr or OpenTelemetry for logging. Elicitation remains available through Multi Round-Trip Requests, where a server returns an input request and the client retries the original operation. A modern server never starts an independent JSON-RPC request.

### JSON-RPC envelopes

MCP uses JSON-RPC 2.0:

- Request: `{jsonrpc, id, method, params}`
- Response: `{jsonrpc, id, result}` or `{jsonrpc, id, error}`
- Notification: `{jsonrpc, method, params}` with no `id`

The request `id` correlates one response. It does not create a protocol session.

### Required request metadata

Every modern request carries a `_meta` object inside `params`:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/list",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "course-client",
        "version": "1.0.0"
      }
    }
  }
}
```

The protocol version and client capabilities are required. Client identity is recommended. It is self-reported display and debugging data, not a security credential.

The server must not infer any of these values from an earlier request, a stdio process, an HTTP connection, or a transport header alone.

### Complete results and server identity

Every successful modern result includes `resultType`. A normal final result uses `"complete"`. Servers should also identify themselves in result metadata:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "resultType": "complete",
    "tools": [],
    "ttlMs": 30000,
    "cacheScope": "public",
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "notes-server",
        "version": "1.0.0"
      }
    }
  }
}
```

`tools/list`, `resources/list`, `prompts/list`, `resources/templates/list`, `resources/read`, and `server/discover` are cacheable results. They include `ttlMs` and `cacheScope`. A safe default is `ttlMs: 0` and `cacheScope: "private"`. List items should have deterministic ordering so equivalent responses produce stable cache keys and stable model context.

### Discovery without a handshake

Every modern server must implement `server/discover`. The client may call it before another method to retrieve:

- `supportedVersions`
- server `capabilities`
- optional usage `instructions`
- server identity in result `_meta`
- cache hints

Discovery is useful, but it is not a gate. A client can send `tools/list` first because that request already carries its protocol version and capabilities.

If the requested version is unsupported, the server returns JSON-RPC code `-32022` with:

```json
{
  "requested": "2027-01-01",
  "supported": ["2026-07-28"]
}
```

The client selects a mutually supported modern version and retries with a new JSON-RPC request id.

### One request lifecycle

Trace a modern request in this order:

1. Parse one JSON-RPC envelope.
2. Confirm `jsonrpc` is `"2.0"`, an `id` exists, and `params` is an object.
3. Read the version and capabilities from `params._meta`.
4. Reject an unsupported version with `-32022`.
5. Route by `method` and validate method-specific arguments.
6. Return a complete result with server identity.
7. Forget request-scoped metadata.

Closing stdin or an HTTP response ends transport activity. It does not terminate a protocol session because modern MCP has no protocol session.

### Explicit legacy compatibility

Versions through `2025-11-25` use `initialize`, `notifications/initialized`, connection-scoped capabilities, and, on earlier Streamable HTTP, optional protocol sessions. That behavior is still relevant when a dual-era client talks to an old server.

Keep the eras separate. A modern request is identified by the required per-request metadata. A legacy connection is selected only through the documented fallback path. Do not send `initialize` as the default for a `2026-07-28` server.

```figure
mcp-tool-call
```

## Use It

`code/main.py` builds, validates, traces, and dispatches modern MCP messages without a framework. Run:

```bash
python3 code/main.py
python3 -m unittest discover code/tests -v
```

Watch for three invariants in the output:

- Every request repeats its `_meta` fields.
- Every successful result is `resultType: "complete"` and includes server identity.
- The list result is deterministically ordered and has explicit cache hints.

## Ship It

This lesson ships `outputs/skill-mcp-handshake-tracer.md`. The historical filename remains stable, but the artifact is now a stateless request tracer. It audits each message independently and labels legacy handshake traffic only when it is genuinely present.

## Exercises

1. Change one request's protocol version to `2027-01-01`. Confirm the error code is `-32022` and the data advertises the supported version.
2. Remove `io.modelcontextprotocol/clientCapabilities` from the second request. Confirm the server does not reuse capabilities from the first request.
3. Reverse the in-memory tool registry. Confirm `tools/list` still returns the same deterministic order.
4. Change `cacheScope` from `public` to `private`. Explain which authorization contexts may reuse the response in each case.
5. Add an optional `clientInfo` omission test. The request should remain valid because client identity is recommended, not required.

## Key Terms

| Term | Meaning |
|------|---------|
| Stateless protocol | Every request supplies the metadata needed to interpret it |
| Request metadata | Version, client capabilities, and recommended client identity in `params._meta` |
| `server/discover` | Mandatory server method for versions, capabilities, instructions, and identity |
| `resultType` | Discriminator on every successful modern result |
| Cacheable result | Result that includes required `ttlMs` and `cacheScope` hints |
| Protocol era | Modern per-request metadata or legacy connection-scoped initialization |
| Transport lifetime | Process, connection, or response-stream lifetime, not protocol session state |
| `-32022` | Unsupported protocol version error with requested and supported versions |

## Further Reading

- [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/)
- [MCP Architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)
- [MCP Base Protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic)
- [MCP Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP 2026-07-28 Changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
