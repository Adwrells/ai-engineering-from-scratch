# Phase 13: Tools & Protocols

> The interfaces between AI and the real world.

This phase moves from function calls and tool schemas into interoperable
protocols, Agent Skills, security, and production governance. Most learners
should follow the numbered lessons. If Agent Skills are your immediate goal,
use the focused path below.

## MCP 2026 stateless path

Lessons 06 through 18 now follow the MCP 2026-07-28 revision. Start with
[Lesson 06](06-mcp-fundamentals/) and continue in number order. The current
contract is deliberately stateless:

- every request declares the protocol version and client capabilities in
  `params._meta`;
- `server/discover` replaces initialization as the capability snapshot;
- Streamable HTTP uses one `POST /mcp` endpoint, with JSON or request-scoped
  SSE responses;
- Multi Round-Trip Requests replace server-initiated roots, sampling, and
  elicitation;
- long-running work uses the official tasks extension and subscriptions use
  `subscriptions/listen`;
- OAuth identity and authorization are validated independently on every
  request.

Older `initialize`, `Mcp-Session-Id`, standalone SSE `GET`, session `DELETE`,
and server-initiated request flows appear only in explicit compatibility notes.
Use the [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
as the revision boundary when comparing older implementations.

## Agent Skills fast path

The focused route is five lessons and about 9 hours 30 minutes:

| Step | Lesson | Outcome | Time |
|---:|---|---|---:|
| 1 | [22: Portable Contract and Runtime Boundary](22-skills-and-agent-sdks/) | Create, install, invoke, verify, and remove a complete skill bundle. | 90 min |
| 2 | [24: Discovery and Progressive Disclosure](24-skill-discovery-and-progressive-disclosure/) | Trace discovery, cataloging, activation, and resource loading. | 105 min |
| 3 | [25: Invocation and Routing](25-skill-invocation-and-routing/) | Control explicit, implicit, human, model, and abstention paths. | 105 min |
| 4 | [26: Permissions, Sandboxes, and Trust](26-skill-permissions-sandboxes-and-trust/) | Separate instructions, permissions, containment, and verification. | 120 min |
| 5 | [27: Evals, Packaging, and Portability](27-skill-evals-packaging-and-portability/) | Build a release gate and prove behavior in real hosts. | 150 min |

Start with the invocation supported by your host:

| Host | Invocation |
|---|---|
| Codex | `$learn-agent-skills`, or choose `learn-agent-skills` from `/skills` |
| Claude Code | `/learn-agent-skills` |
| Other compatible hosts | `Use learn-agent-skills to start or resume the Agent Skills Engineering path.` |

The tutor creates or resumes `AGENT-SKILLS-LEARNING.md`, teaches one lesson per
invocation, and records the evidence required by each checkpoint. The route is
defined in
[`learning-paths/agent-skills.json`](../../learning-paths/agent-skills.json).

If you prefer the website, start with
[Lesson 22](https://aiengineeringfromscratch.com/lesson.html?path=phases/13-tools-and-protocols/22-skills-and-agent-sdks&learningPath=agent-skills).
Its first lab gets a skill into a real host in about ten minutes.

### Prerequisite fast lane

- For the real labs, you need `node`, `npx`, `python3`, one selected
  skill-capable host, and write access to the chosen project or user skill
  scope. Verify the three commands with `node --version`, `npx --version`, and
  `python3 --version` before installing.
- If that preflight is unavailable, use the website or read each `docs/en.md`
  manually. You can complete the conceptual work, but keep discovery,
  invocation, script, update, and uninstall evidence marked pending.
- Skim [Lesson 01](01-the-tool-interface/) and [Lesson 05](05-tool-schema-design/)
  if tool contracts are new to you.
- Complete [Lesson 15](15-mcp-security-tool-poisoning/) before Lesson 26, or
  be able to explain tool poisoning and untrusted instructions.
- [Lesson 23](23-capstone-tool-ecosystem/) is an optional systems capstone,
  not the next Agent Skills lesson after 22. Complete lessons 06 through 20
  before taking it.

## Full phase

See [ROADMAP.md](../../ROADMAP.md) for the full lesson plan.
