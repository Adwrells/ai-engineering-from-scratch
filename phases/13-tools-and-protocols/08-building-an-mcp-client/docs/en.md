# Building an MCP Client: Discovery, Routing, and Dual-Era Fallback

> A modern MCP client repeats its contract on every request. Its hardest compatibility decision is knowing when an old server is truly old and when a modern server is reporting a correctable error.

**Type:** Build
**Languages:** Python
**Prerequisites:** Phase 13, Lesson 07
**Time:** ~85 minutes

## Learning Objectives

- Build every MCP `2026-07-28` request with current metadata.
- Probe stdio servers with `server/discover` and select a mutually supported version.
- Fall back to legacy initialization only after non-modern evidence or timeout.
- Merge deterministic tool lists without silently overwriting collisions.
- Route calls to the peer that owns each tool without inventing protocol sessions.

## The Problem

An agent host usually talks to more than one MCP server. It must discover each server, merge tool catalogs, resolve duplicate names, route calls, and recover from transport failure.

The `2026-07-28` revision makes the steady state simpler because each request is self-contained. Compatibility makes startup more subtle. A client may encounter:

- a modern server that supports the preferred version;
- a modern server that returns a recognized version or header error;
- a legacy server that has never heard of `server/discover`;
- a legacy server that stays silent until it receives `initialize`.

Treating every probe error as legacy is dangerous. A malformed modern request could make the client downgrade and bypass the modern contract. The client must classify evidence before it chooses an era.

## The Concept

### A peer, not a protocol session

Keep one transport peer record for each server process or endpoint:

- transport handle or send function;
- selected protocol era and version;
- last discovered server capabilities;
- last deterministic tool list;
- pending request ids for correlation;
- transport health.

This is client bookkeeping. It is not protocol session state. On modern MCP, the server still receives current version and capabilities on every request.

### Build every modern request from scratch

```python
def modern_request(request_id, method, params, version, capabilities):
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": {
            **params,
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": version,
                "io.modelcontextprotocol/clientCapabilities": capabilities,
                "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
            },
        },
    }
```

Do not attach metadata once to a connection object and assume it reached the wire. Stamp and inspect the final serialized request.

### Modern discovery

`server/discover` returns supported versions, server capabilities, instructions, cache hints, and recommended server identity. A client chooses the highest mutually supported modern version.

Discovery is optional for a modern-only client, but it is recommended on stdio. Some legacy servers accept an operation before initialization, so sending `tools/list` first can produce an ambiguous success. `server/discover` creates a clean era boundary.

### The stdio compatibility probe

A dual-era stdio client sends `server/discover` with its preferred modern metadata before any other request. There are three outcomes:

1. **DiscoverResult.** The server is modern. Select a mutually supported version and continue with per-request metadata.
2. **Recognized modern error.** The server is modern. For `-32022`, choose from `data.supported` and retry with a new request id. For header or capability errors, correct the request. Do not send `initialize`.
3. **Any other error or reasonable timeout.** The server is legacy. Use its era's `initialize` and `notifications/initialized` exchange.

Recognized modern protocol errors include:

- `-32020` HeaderMismatch
- `-32021` MissingRequiredClientCapability
- `-32022` UnsupportedProtocolVersion

Do not key fallback only to `-32601`. Legacy implementations return different errors for a pre-initialization method, and some do not answer.

Cache the selected era for the transport peer. Do not probe again before every call.

### Legacy is a compatibility branch

Once the client has actual legacy evidence, it uses the selected legacy version exactly as defined by that revision:

1. Send `initialize` with legacy capabilities and client identity.
2. Read the negotiated legacy version and server capabilities.
3. Send `notifications/initialized`.
4. Use legacy request shapes for that transport lifetime.

This branch exists for interoperability. It is not the default design for new servers or new requests.

### Discovering and caching tools

For each active peer, call `tools/list`. A modern result includes `resultType`, `ttlMs`, and `cacheScope`. Honor the freshness hint within the correct authorization context. Re-fetch after expiry or a subscribed list-change event.

Clients must treat a missing `resultType` from a legacy server as `"complete"`. Do not require modern cache fields on a response from an earlier negotiated era.

The server should return deterministic ordering. The client should also sort before merging so local registry order does not depend on process startup timing.

### Collision-safe namespace merge

Two servers may both expose `search`. Choose a declared policy:

1. **Prefix on collision.** Keep the first canonical name and expose later collisions as `<server>/<tool>`.
2. **Reject on collision.** Do not load the duplicate and surface a clear configuration error.
3. **Silent overwrite.** Never use this. It hides which server receives a model-selected action.

Store both canonical and local names. The model sees the canonical name. The outgoing `tools/call` uses the local name the owning server declared.

### Routing a call

Routing is a pure lookup:

```text
canonical tool name
  -> peer name + local tool name
  -> new JSON-RPC request id
  -> modern request metadata or explicit legacy shape
  -> matching response id
```

Do not send a call when its owning transport is unavailable. Reconnect or restart the transport, then re-run discovery and `tools/list`. Modern in-flight requests lost on a broken transport can be retried with a new JSON-RPC id when the operation's safety policy permits it.

### Notifications and subscriptions

Modern list and resource changes arrive only on a client-opened `subscriptions/listen` stream. The client sends the notification filter, waits for `notifications/subscriptions/acknowledged`, and correlates events with the listen request id in notification metadata.

On disconnect, open a new listen request and refetch relevant lists or resources. Modern streams do not resume with `Last-Event-ID`.

### No server-initiated requests

Modern servers do not call the client with independent JSON-RPC requests for sampling, elicitation, or roots. They return `input_required`, and the client retries the original request after fulfilling the embedded input requests.

Do not block the peer's response reader while fulfilling input. Preserve correlation and create a new JSON-RPC id for the retry.

```figure
tp-client-merge
```

## Use It

`code/main.py` uses in-process peer functions so the protocol decisions stay visible. It connects to two modern peers and one intentionally legacy peer, then merges and routes their tools.

```bash
cd code
python3 main.py
python3 -m unittest discover tests -v
```

The tests prove four boundaries that normal demos miss:

- modern requests repeat metadata;
- `-32022` retries modern discovery without initialization;
- `-32020` fails as modern instead of downgrading;
- an unrecognized `-32601` probe response selects the legacy branch.

## Ship It

This lesson ships `outputs/skill-mcp-client-harness.md`. It scaffolds modern request stamping, stdio era negotiation, deterministic namespace merge, routing, and an isolated legacy fallback.

## Exercises

1. Make a fake server return `-32022` with no mutually supported version. Confirm the client fails instead of sending `initialize`.
2. Make a fake legacy server time out on `server/discover`. Add a bounded timeout and prove it falls back once.
3. Add `cacheScope: "private"` tool lists for two authorization contexts. Confirm the client never shares one context's cached result with the other.
4. Change the collision policy to rejection and make startup fail with both peer names in the error.
5. Add a finite `subscriptions/listen` simulator. On stream loss, re-listen with a new request id and refetch tools.

## Key Terms

| Term | Meaning |
|------|---------|
| Peer | Client-side record for one server transport and its discovered data |
| Protocol era | Modern per-request metadata or legacy initialization semantics |
| Discovery probe | Initial `server/discover` used to identify the stdio era |
| Recognized modern error | Error that proves modern behavior and forbids legacy fallback |
| Merged namespace | Canonical tool names across all active peers |
| Collision policy | Prefix or reject rule for duplicate tool names |
| Era cache | Selected modern or legacy behavior stored for one transport peer |
| Transport recovery | Restart or reconnect, rediscover, relist, and retry safely with a new id |

## Further Reading

- [MCP Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/)
- [MCP Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP stdio Transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [MCP Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
