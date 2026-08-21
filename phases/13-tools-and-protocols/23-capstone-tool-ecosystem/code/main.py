"""Phase 13 Capstone - in-process research-and-report simulation.

Several Phase 13 boundaries in one readable demo:
  - gateway-shaped static token lookup and RBAC
  - local tool functions returning task- and ui-shaped data
  - A2A-shaped writer delegation represented by a nested span
  - in-memory trace dictionaries sharing one trace id
  - pinned-hash manifest guarding description mutations

This file does not implement an MCP or A2A transport, OAuth exchange, MCP App
bridge, telemetry exporter, or execution sandbox. Stdlib only.

Run: python code/main.py
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field


SPANS: list[dict] = []


def _hex(n: int) -> str:
    return uuid.uuid4().hex[: n * 2]


def span(name: str, kind: str, trace_id: str | None, parent: str | None,
         attrs: dict) -> dict:
    tid = trace_id or _hex(16)
    sp = {"name": name, "kind": kind, "traceId": tid, "spanId": _hex(8),
          "parentSpanId": parent, "start": time.time_ns(), "attrs": attrs, "end": 0}
    SPANS.append(sp)
    return sp


def finish(sp: dict) -> None:
    sp["end"] = max(time.time_ns(), sp["start"] + 1)


TOOLS = [
    {"name": "arxiv_search", "description": "Use when the user searches arXiv by keyword."},
    {"name": "generate_report", "description": "Use when the user wants a full report."},
]

PAPERS = [
    {"arxiv_id": "2603.22489", "title": "Tool poisoning attacks on MCP deployments"},
    {"arxiv_id": "2604.01055", "title": "Agent-to-agent coordination benchmarks"},
    {"arxiv_id": "2603.30016", "title": "Long-running tool calls via Tasks"},
]

PINNED = {f"research::{t['name']}": hashlib.sha256(t["description"].encode()).hexdigest()
          for t in TOOLS}


def research_arxiv_search(args: dict) -> dict:
    q = args["query"].lower()
    hits = [p for p in PAPERS if q in p["title"].lower()]
    return {"content": [{"type": "text", "text": json.dumps(hits)}], "isError": False}


def research_generate_report(args: dict, trace_id: str, parent: str) -> dict:
    task_id = f"tsk_{uuid.uuid4().hex[:10]}"
    sp = span("mcp.task.working", "INTERNAL", trace_id, parent,
              {"gen_ai.operation.name": "execute_tool", "mcp.task.id": task_id})
    a2a = span("a2a.SendMessage", "CLIENT", trace_id, sp["spanId"],
               {"a2a.peer": "writer-agent", "a2a.skill": "summarize_papers"})
    finish(a2a)
    finish(sp)
    html = (
        "<!doctype html><html><body>"
        "<h1>Agent-protocol arXiv report</h1><ul>"
        + "".join(f"<li>{p['arxiv_id']}: {p['title']}</li>" for p in PAPERS)
        + "</ul><script>/* A real MCP App bridge is intentionally absent. */</script></body></html>"
    )
    return {
        "_meta": {"task": {"id": task_id, "state": "completed", "ttl": 900_000},
                  "ui": {"resourceUri": "ui://report/current",
                         "csp": {"default-src": "'self'"},
                         "permissions": []}},
        "content": [
            {"type": "text", "text": "Report generated: 3 papers summarized."},
            {"type": "ui_resource", "uri": "ui://report/current"},
        ],
        "_html": html,
    }


USERS = {
    "tok_alice": {"id": "alice", "scopes": {"research:read", "research:write"}},
    "tok_bob":   {"id": "bob",   "scopes": {"research:read"}},
}
REQUIRED_SCOPE = {"arxiv_search": "research:read",
                  "generate_report": "research:write"}

AUDIT: list[dict] = []


def pin_ok(tool_name: str, description: str) -> bool:
    return PINNED.get(f"research::{tool_name}") == hashlib.sha256(description.encode()).hexdigest()


def gateway_call(token: str, tool_name: str, args: dict,
                 trace_id: str, parent: str) -> dict:
    u = USERS.get(token)
    if not u:
        return {"error": "unauthenticated"}
    required = REQUIRED_SCOPE.get(tool_name)
    if required and required not in u["scopes"]:
        AUDIT.append({"user": u["id"], "tool": tool_name, "decision": "403"})
        return {"error": "insufficient_scope", "scope": required}
    tool = next((t for t in TOOLS if t["name"] == tool_name), None)
    if tool is None:
        return {"error": "unknown tool"}
    if not pin_ok(tool_name, tool["description"]):
        return {"error": "hash_mismatch"}
    sp = span("mcp.call", "CLIENT", trace_id, parent,
              {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": tool_name,
               "gateway.user": u["id"], "mcp.server": "research"})
    if tool_name == "arxiv_search":
        result = research_arxiv_search(args)
    else:
        result = research_generate_report(args, trace_id, sp["spanId"])
    finish(sp)
    AUDIT.append({"user": u["id"], "tool": tool_name, "decision": "allow"})
    return result


def orchestrator(token: str, user_query: str) -> dict:
    trace_id = _hex(16)
    root = span("agent.invoke_agent", "INTERNAL", trace_id, None,
                {"gen_ai.operation.name": "invoke_agent",
                 "gen_ai.agent.name": "research-orchestrator"})

    llm1 = span("llm.chat", "CLIENT", trace_id, root["spanId"],
                {"gen_ai.operation.name": "chat", "gen_ai.provider.name": "openai",
                 "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": 24})
    finish(llm1)

    search = gateway_call(token, "arxiv_search",
                          {"query": "agent protocol"}, trace_id, root["spanId"])
    report = gateway_call(token, "generate_report",
                          {"format": "html"}, trace_id, root["spanId"])

    llm2 = span("llm.chat", "CLIENT", trace_id, root["spanId"],
                {"gen_ai.operation.name": "chat", "gen_ai.provider.name": "openai",
                 "gen_ai.request.model": "gpt-4o", "gen_ai.usage.output_tokens": 85})
    finish(llm2)

    finish(root)
    return {"trace_id": trace_id, "search": search, "report": report}


def demo() -> None:
    print("=" * 72)
    print("PHASE 13 CAPSTONE - RESEARCH AND REPORT ECOSYSTEM")
    print("=" * 72)

    print("\n--- orchestrator run as alice (read+write) ---")
    out = orchestrator("tok_alice", "summarize the three most-cited 2026 arXiv papers")
    print(f"  trace id      : {out['trace_id']}")
    print(f"  search result : {out['search']['content'][0]['text']}")
    print(f"  report status : task completed, ui:// resource returned")
    print(f"  ui bytes      : {len(out['report']['_html'])}")

    print("\n--- orchestrator run as bob (read only) ---")
    out = orchestrator("tok_bob", "generate a report")
    print(f"  generate_report -> {out['report']}")

    print("\n--- audit log ---")
    for row in AUDIT:
        print(f"  {row}")

    print("\n--- OTel GenAI spans ---")
    for sp in SPANS:
        dur_ms = round((sp['end'] - sp['start']) / 1_000_000, 2) if sp['end'] else 0
        parent = sp['parentSpanId'][:6] if sp['parentSpanId'] else "ROOT"
        print(f"  [{sp['traceId'][:6]}] {sp['name']:20s} {sp['kind']:8s} "
              f"parent={parent}  dur={dur_ms}ms")

    print("\n--- primitive coverage ---")
    covered = [
        "tool interface and direct function dispatch",
        "structured content dictionaries",
        "task-shaped identifier and completed result",
        "ui://-shaped resource reference",
        "description mutation detection with pinned hashes",
        "static-token scope and gateway policy simulation",
        "A2A-shaped opaque delegation boundary",
        "in-memory trace identifiers and parent span identifiers",
        "orchestrator routing between local operations",
    ]
    for c in covered:
        print(f"  + {c}")


if __name__ == "__main__":
    demo()
