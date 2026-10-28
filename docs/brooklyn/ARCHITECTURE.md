# Brooklyn: Architecture

Base: OpenBot commit `ef13020`, `@copilotkit/runtime` 1.77.0 (MIT).
Everything here was read from source unless marked **unverified**.

---

## 1. The idea in one picture

```
TODAY (OpenBot)                         TARGET (Brooklyn)

 Browser app                             Browser app
     |                                       |
 Server (Hono, 3001)                     Server (Hono, 3001)
     |                                       |
 CopilotRuntime                          CopilotRuntime (built-in non-Intelligence mode)
  "intelligence mode"                        |
     |                                   PostgresAgentRunner  <-- we write this
 CopilotKit Intelligence                     |
  (hosted: threads, locks,               PostgreSQL (threads, runs, locks,
   websocket runner, memory,                 memory, learning)
   learning analysis)
```

The runtime has a second mode that accepts "a runner you control". We use that mode and supply our own runner.

---

## 2. Services

| Service | Port | Job |
|---|---|---|
| `app` | 3010 | React UI |
| `server` | 3001 | API, CopilotKit runtime, auth, policy, audit, channels |
| `agent-computer` | 4100 | Chromium + `/workspace` per Bot |
| `supervisor` | 4500 (host) / 4300 (container) | Creates one computer container per Bot. Holds the Docker socket |
| `agent-bot`, `agent-langgraph` | 4200, 4201 | Sample Bots shipped with OpenBot |
| `worker` | none | Fires due routines |
| `postgres` (pgvector) | 5432 | All product data |

Compose services: `postgres`, `migrate`, `agent-computer`, `supervisor`, `agent-bot`, `agent-langgraph`, `agent-harness`, plus optional `spire-*` that `start.sh` does not start.

---

## 3. What Intelligence does today, and what replaces it

| Job | Today | Brooklyn |
|---|---|---|
| Thread store | Hosted | Postgres: `threads`, `thread_runs` |
| Live run connection | Websocket to a hosted gateway. Events must be acknowledged within 60 s | In-process stream, saved to Postgres |
| One run per thread | Hosted lock, 120 s lease, `409` when busy | Postgres `thread_locks` |
| Memory | Hosted ranked recall (OpenBot falls back to substring match) | `PostgresMemory` with pgvector |
| Learning | Hosted analysis and review; delivery inside OpenBot | Rebuilt: our analyzer and review panel; delivery over Postgres |

Details: `INTELLIGENCE-REPLACEMENT.md`.

---

## 4. A run, in the target

1. Browser sends a message to the server (behind the session guard).
2. The Copilot handler passes it to the runtime, which calls `PostgresAgentRunner.run`.
3. The runner takes the thread lock, runs the Bot (`agent.runAgent`), and streams AG-UI events to the browser while saving them.
4. Every browser or file action a Bot takes returns through the **gateway**: resolve target, check policy, write audit row, then act. This path is unchanged.
5. The run ends with `finalizeRunEvents`; the lock is released.
6. Reopening the chat: `connect` replays stored events, then follows the run if one is live.

Routines (worker to server) and Bot-to-Bot hand-offs use the **same** runner instance and the same lock. Today there are three separate Intelligence runners (runtime, routines at `index.ts` ~1651, hand-offs at `handoff-wiring.ts` ~126). That becomes one.

---

## 5. The seams (where we cut)

| Seam | Where | Shape |
|---|---|---|
| Boot gate | `server/src/config.ts` `runtimeCapabilities` | `RuntimeCapabilities` union: `intelligence` or `postgres` |
| Runtime construction | `server/src/copilot.ts` ~1777 | Pass `runner` instead of `intelligence` |
| Runner | SDK abstract `AgentRunner` | `run`, `connect`, `isRunning`, `stop` |
| Thread access | `toolkit/src/run-turn.ts` `IntelligenceLike` + `toolkit/src/ports.ts` `ThreadLock` | Narrow interfaces OpenBot already wrote. We reuse their shape as `ThreadBackend` |
| Memory | `server/src/memory/store.ts` `createMemoryStore(db, {intelligence?})` | `IntelligenceMemory`: `available, list, recall, create, supersede, remove` |
| Learning delivery | `server/src/learning/runtime.ts` `AcquireLearnedSkills` | `(agentId, signal) => {catalog, tools, execute}`. Consumed in `copilot.ts` ~410-449, ~1024, ~1495 |

---

## 6. New tables (proposed, not built)

| Table | Columns |
|---|---|
| `threads` | id, user_id, agent_id, name, archived, created_at, updated_at |
| `thread_runs` | thread_id, run_id, parent_run_id, agent_id, events (jsonb, compacted), messages (jsonb snapshot), created_at |
| `thread_locks` | thread_id (PK), run_id, user_id, agent_id, expires_at |
| `learning_evidence`, `learning_candidates`, `learning_skills`, `learning_skill_revisions` | Defined in Phase 6 |
| memory embeddings | Defined in Phase 5 |

Existing tables stay: `intelligence_channel_mappings`, `group_bot_threads`, `learning_settings`, `learning_thread_bindings`, and nine tables that hold a `thread_id` (admin, core, delivery, group x2, learning, passwords, proactive, responsibilities).

---

## 7. Groups

The "one agent per thread" rule came from Intelligence. OpenBot already works around it: each Bot in a group has its own thread (`group_bot_threads`) and the people read a shared transcript (`group_messages`). A Bot that names a peer as `@Name` hands the conversation over. **We keep this unchanged.** Simplifying it is optional and later.

---

## 8. Reading the SDK

Everything we mimic is readable inside the installed `@copilotkit/runtime` package, `dist/v2/runtime/`:

| File | Why read it |
|---|---|
| `runner/agent-runner.mjs` | The abstract interface |
| `runner/in-memory.mjs` | Template for our runner (run, connect, stop, thread reads) |
| `runner/intelligence.mjs` | The event rules our runner must match |
| `core/runtime.mjs` | The two runtime modes and their constructor checks |
| `handlers/intelligence/threads.mjs` | Why the local thread routes are unsafe (see `SECURITY.md`) |

The SDK's `internal/` exports are not a stable API. Do not build on them.

---

## 9. Version pins

- OpenBot base: `ef13020` (tag `base-ef13020`)
- `@copilotkit/runtime` and `@copilotkit/react-core`: 1.77.0
- `toolkit/src/run-turn.ts` says it was written against runtime 1.69.0 and must be re-read on upgrade. Do not upgrade during the swap.
- Postgres image: `pgvector/pgvector:pg17`

---

## 10. Not yet verified

- Server never booted in the research sandbox (no Docker there). Evidence is source reading and one compile test.
- Browser app behaviour in the non-Intelligence mode (Phase 4).
- Whether Windows + WSL2 + the supervisor's Docker socket works (Phase 0).
