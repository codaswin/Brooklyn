# Brooklyn: Replacing CopilotKit Intelligence with Postgres

**Status:** Research only. No code in OpenBot was changed.
**Based on:** OpenBot commit `ef13020`, `@copilotkit/runtime` 1.77.0 (MIT).
**Method:** Read OpenBot source + the MIT runtime package. One compile test in a throwaway clone.
**Not done:** Server was never booted (no Docker/Postgres in the research sandbox).

---

## 1. Decision

Remove Intelligence. Replace threads, locks, run storage with plain Postgres.
Nothing here bypasses CopilotKit licensing. We remove a dependency from MIT code.
The licence checker only exists inside the Intelligence runtime class, so there is nothing to bypass.

---

## 2. What Intelligence does for OpenBot today

| Job | Plain meaning |
|---|---|
| Thread store | Keeps every conversation and its messages |
| Runner | Live run connection (websocket). Events are queued until acknowledged |
| Thread lock | One run at a time per conversation |
| Memory + Learning | Optional extras. OpenBot already works without them |

---

## 3. The contract (what we must replace)

| Intelligence call | What it does | Used in | Postgres replacement |
|---|---|---|---|
| `getOrCreateThread({threadId,userId,agentId})` | Create thread if missing. Safe to repeat | `toolkit/run-turn.ts`, `thread-lock.ts` | `INSERT ... ON CONFLICT DO NOTHING` |
| `getThread({threadId,userId})` | 404 if thread is gone | `channels/thread-status.ts` | `SELECT`. No row = "unknown" |
| `getThreadMessages({threadId,userId})` | Returns `{messages:[{id, role, content, activityType, toolCalls[{id,name,args}], toolCallId}]}` | `copilot.ts` (history), `run-turn.ts` | Rebuild from stored events, or store a message snapshot per run |
| `ɵacquireThreadLock({threadId,runId,userId,agentId,ttlSeconds})` | Take the lock. **409 if already held**. Returns `{runId}` | `thread-lock.ts`, `run-turn.ts` | `thread_locks` row. Insert if absent or expired |
| `ɵrenewThreadLock({threadId,runId,ttlSeconds})` | Extend the lease | same | `UPDATE expires_at` where `run_id` matches |
| `ɵcleanupThreadLock({threadId,runId})` | Release | same | `DELETE` where `run_id` matches |
| `IntelligenceAgentRunner` (websocket) | Streams events to the gateway. Run fails if events are not acknowledged in 60 s | `copilot.ts` (runtime), `index.ts:1651` (routines), `handoff-wiring.ts:126` (handoffs) | One shared `PostgresAgentRunner` |
| `getRuntimeEntitlements`, `getInspectorMetadata` | Plan / licence checks, banner | `memory/intelligence.ts`, `self-host-banner.ts`, `intelligence-entitlement-check.ts`, `learning/auto-assign.ts` | Delete |
| Memory calls (`createMemory`, `recallMemories`, ...) | Memory on Intelligence | `memory/intelligence.ts` | Skip. `createMemoryStore` takes `intelligence?` as optional and falls back to OpenBot tables |
| Learning containers | Automatic Learning (collect, analyze, review, deliver) | `learning/*`, `scripts/setup-learning.ts`, admin Learning page | **Kept. Rebuilt on Postgres.** See section 10c |

Notes from the repo's own comments (not checked against the hosted service):
- Lock is Redis-backed on the platform. TTL fixed at 120 s.
- Written against runtime 1.69.0. Now pinned at 1.77.0. Comments say to re-read on each upgrade.

---

## 4. The boot gate and the exact work list

**Where it refuses:** `server/src/config.ts`, function `runtimeCapabilities`.
It throws `CopilotKit Intelligence is required and is not configured` if any of the 3 vars is missing.

**The fix (tested in a throwaway clone):**
1. Make the type a union: `mode: "intelligence"` or `mode: "postgres"` (with no Intelligence settings).
2. When all 3 vars are absent and `THREAD_BACKEND=postgres`, return `mode: "postgres"`.
3. Keep the rule that a **partial** set is still an error.

**What the compiler then flags: 14 errors, 3 files.**

| File | Lines |
|---|---|
| `server/src/app.ts` | 1934 |
| `server/src/copilot.ts` | 1749, 1750, 1751, 1787 |
| `server/src/index.ts` | 343, 352, 377, 378, 692, 693, 694, 1245, 2361 |

Also needed (compiler will not flag these):
- `new IntelligenceAgentRunner(...)` at `index.ts:1651` and `handoff-wiring.ts:126`.
- Runtime construction at `copilot.ts:1777` (pass a `runner`, not `intelligence`).
- `start.sh`, `docker-compose.yml`, `.env.example`, Helm chart, desktop app: remove the 3 required vars.

---

## 5. Replacement design (proposed, not built)

**Runtime mode:** Run `CopilotRuntime` in its built-in **SSE mode**, which accepts "a runner you control".

**The runner:** Implement the abstract `AgentRunner`. Four methods:
- `run(request)`: run the agent, stamp events, finish with `finalizeRunEvents`, save to Postgres
- `connect(request)`: replay stored events, then follow the live run
- `isRunning(request)`
- `stop(request)`

**Template:** The MIT `InMemoryAgentRunner` (555 lines) has the same logic. Swap its in-process store for Postgres.
Behaviour to copy from `IntelligenceAgentRunner.run`:
- set `agent.threadId`, call `agent.runAgent(input, {onEvent})`
- guarantee a `RUN_STARTED` event, using `persistedInputMessages`
- on failure, push `RUN_ERROR`
- always finish with `finalizeRunEvents`

**Proposed tables:**

| Table | Columns |
|---|---|
| `threads` | id, user_id, agent_id, name, archived, created_at, updated_at |
| `thread_runs` | thread_id, run_id, parent_run_id, agent_id, events (jsonb, compacted), messages (jsonb snapshot), created_at |
| `thread_locks` | thread_id (PK), run_id, user_id, agent_id, expires_at |

**One runner, three users:** runtime, routines, handoffs must share one instance.
(Today there are three separate Intelligence runners.)

**Live follow:** One process on a laptop: in-process stream is enough.
Many replicas or a VPS later: add Postgres `LISTEN/NOTIFY`. Leave a seam for it.

**Groups:** Keep OpenBot's per-bot threads (`group_bot_threads`). No change needed.
That rule ("one agent per thread") came from Intelligence, but OpenBot's group code already handles it.

---

## 6. SECURITY: must fix before anything else

SSE mode removes user isolation. Found in the runtime source:

| Finding | Evidence |
|---|---|
| SSE runtime ignores `identifyUser` | Only the Intelligence runtime class sets it |
| Runner only receives a `threadId`, never a user | `AgentRunnerRunRequest` has no user field |
| Local thread list returns **all users' threads** | `handlers/intelligence/threads.mjs`, only filtered by `agentId` |
| `POST /threads/clear` wipes **all** threads | same file, `handleClearThreads` |
| Read endpoints take a bare `threadId` | no owner check |

**Today:** OpenBot mounts the handler at `app.ts:1367`, behind the session guard (logged in), but with no per-thread owner check.

**Required fixes:**
1. Do **not** set `ɵsupportsLocalThreadEndpoints` on our runner. Those thread routes then answer 422.
2. Add a guard before `app.route("/", copilotHandler)`: for run / connect / stop, look up the `threadId` owner in OpenBot's own tables (`intelligence_channel_mappings`, `group_bot_threads`, channel memberships) and deny unless it matches the session user.
3. Serve history through OpenBot's own user-scoped routes.
4. Write a test: user A cannot connect to, run on, or read user B's thread.

---

## 7. What stays untouched

- Memory code (already optional; swap in `PostgresMemory`)
- Learning **delivery** code in `copilot.ts` (it only calls `acquireLearnedSkills`; we change what that returns)
- Channels, groups, handoffs logic, routines logic
- Tables `intelligence_channel_mappings`, `group_bot_threads` (rename later, optional)
- Gateway, audit, policy, computers, skills

---

## 8. Risks and unknowns

- Browser app was **not** tested in SSE mode. SSE returns events in the HTTP stream. Intelligence returns a join token and a websocket. `app/src/lib/copilot/bot-thread.ts` and `routes/_authed/_app/bot.tsx` mention Intelligence and need a test pass.
- 61 test files mention Intelligence. Many use narrow fakes (`IntelligenceLike`) and should survive. Config tests will not.
- Runtime upgrades can break us. We depend on `AgentRunner`, `finalizeRunEvents` (`@copilotkit/shared`), `compactEvents` (`@ag-ui/client`). Pin versions.
- Existing threads in hosted Intelligence will not move. Fresh start.
- Windows: `start.sh` is bash and the supervisor needs the Docker socket. Plan on WSL2.
- Local memory ranking quality was not checked.

---

## 9. Not verified, stated plainly

- Server never booted. Evidence is source reading + a compile test only.
- Nothing about the hosted Intelligence service was probed. "Redis-backed", "120 s", "60 s" come from code comments.
- `rea` (github.com/morluto/rea) was **not installed**. Its setup edits agent config and can download third-party tools. We did not need it: everything here was in MIT source. If you want it later, run `npx rea-agents setup` on your laptop and review the diff first.

---

## 10. Decisions (answered by Aswin, 2026-10-26)

| # | Question | Answer |
|---|---|---|
| 1 | Where does it run? | One process on the laptop. One user (Aswin). Keep a `LISTEN/NOTIFY` seam for later. |
| 2 | Automatic Learning? | **Kept.** (An earlier "drop" was a misread. Corrected by Aswin.) Rebuilt on Postgres, see 10c. |
| 3 | Memory | Same ranked recall OpenBot gets from Intelligence, using free / open-source parts. |
| 4 | Order | Swap first, LinkedIn agent after. |

**Memory finding (checked in `server/src/memory/store.ts`):**
- Without Intelligence, OpenBot recall is a plain substring match (`strpos(lower(content), lower(term))`). No ranking.
- Ranked recall is what Intelligence adds. That is what "the same" means.
- Postgres here already has the `vector` extension (`CREATE EXTENSION vector`, image `pgvector/pgvector:pg17`). Unused by memory today.
- The seam is ready: `createMemoryStore(db, { intelligence?: IntelligenceMemory })`. `IntelligenceMemory` is a 6-method interface: `available, list, recall, create, supersede, remove`.
- **Plan:** write `PostgresMemory` implementing that same interface, pass it in the same slot. Store code does not change.
- **Open choice:** how to make embeddings for free. Options: a small local open-source embedding model on the laptop, or Postgres full-text search as a no-model fallback. Not yet verified which runs well on 16 GB. Decide in the memory phase.

---

## 10b. Security priority, updated for one user

- With one user on a laptop, no one else can reach another person's threads. Section 6 drops from "first" to "before any server or Google sign-in".
- Keep the guard anyway. It is small, and the VPS plan needs it.
- Keep `user_id` columns. OpenBot passes `userId` everywhere; removing them costs more than it saves.

---

## 10c. Automatic Learning: what it is, and how we rebuild it

**Four steps. Two live in OpenBot, two in the hosted service.**

| Step | Today | Where |
|---|---|---|
| 1. Collect evidence | A thread is bound to a "container" when it is created (`learning_thread_bindings`). The hosted service keeps the thread | OpenBot + hosted |
| 2. Analyze | Hosted service reads evidence, **proposes skill candidates** | **Hosted, closed. Not readable.** |
| 3. Review + publish | A person approves candidates in the Intelligence web UI. Publishing makes a numbered revision | **Hosted** |
| 4. Deliver | Each new run calls `acquireLearnedSkills(agentId)`. It returns `{catalog, tools, execute}`. Bot gets 2 tools: `copilotkit_load_skill`, `copilotkit_read_skill_file` (max 10 skill steps per run). Skills grant no tools, only guidance | OpenBot (`learning/runtime.ts`, `learning/remote.ts`, `copilot.ts` lines ~410-449, ~1024, ~1495) |

**Honest limit:** We can rebuild the same flow. We cannot copy step 2 "exactly". That algorithm runs on CopilotKit's servers and is not in any package we can read. REA cannot read a remote backend, and we are not probing the hosted service. Our analyzer is our own design, and tuning it is where Brooklyn's quality will come from.

**Rebuild plan (proposed, not built):**

| Step | New design |
|---|---|
| 1. Evidence | Our own thread tables are the evidence. Keep `learning_settings` and `learning_thread_bindings` |
| 1b. Best evidence | The Manager's verdicts ("redo" / "ok") and **Aswin's final approve / edit / reject**. These are labeled examples of "how Aswin works" |
| 2. Analyze | Scheduled job on OpenBot's existing `work_items` queue. A model reads recent evidence and writes **skill candidates** as `.md` (title, description, SKILL.md body, optional files, links to source threads) |
| 3. Review | Candidates table + panel on the existing `/admin/learning` page. Approve / edit / reject. Approve = new numbered revision. Nothing auto-publishes (same rule as today) |
| 4. Deliver | Implement `acquire` over Postgres. Build catalog + 2 tools + `execute` ourselves. Do **not** use the SDK's `@copilotkit/runtime/internal/learned-skills` (internal, pinned, built around the hosted ZIP) |

**Proposed tables:** `learning_evidence`, `learning_candidates`, `learning_skills`, `learning_skill_revisions`.

**Delete:** `learning/ensure-container.ts` (572 lines), `learning/auto-assign.ts` (419), `scripts/setup-learning.ts`, `scripts/self-hosted-learning.ts`, Intelligence inspector calls.

**Cost warning:** The analyzer spends model tokens. Budget is $15/month. Run it on a manual button or a daily schedule with a spend cap, never on every thread.

**Fit with the "work like me" goal (Aswin's ICM `.md` files):** Learned skills are `.md` files. They sit beside the hand-written ICM expertise. Rule: hand-written ICM files always win over a learned skill if they disagree.

---

## 10d. The LinkedIn vertical agent (answers from Aswin, 2026-10-26)

**Goal:** Manages Aswin's LinkedIn like Aswin does. Works the way the user works. Acts in the UI like Grok Bot: visible, live, in its own browser.

**Scope:** Everything: posts, topic research, outreach DMs, comments, replies.

**Targets (ICP):** Tamil Nadu. Mid and upper-mid businesses, agencies, entrepreneurs, founders.

**Team (3 Bots in one group):**

| Bot | Job |
|---|---|
| Writer | Writes everything: comments, replies, outreach messages, posts |
| Researcher | Researches in the Bot's own browser. Returns real data |
| Manager | Reviews every output (post, comment, DM, research). Says "redo" or "ok". Thinks like Aswin (reads Content_Mind). **Publishes.** Final approval is Aswin's only |

**Expertise source:** Aswin's `.md` files in the ICM method (Jake Van Clief). Content_Mind is his second brain.

**Show on camera:** Real account.

**Mapping to OpenBot (from docs, not yet tested):**
- Group chat with 3 Bots: supported (`/channel/new`, 2+ Bots).
- Writer to Manager to Researcher hand-offs: `message_bot` (typed task, caps, audit rows).
- Manager asks Aswin for final approval: `ask_person`, plus per-Bot approvals (`/bots/:id/approvals`).
- Publishing clicks: the gateway policy (CEL) can see `page.host`, `element.name`, `intent`. Can require approval before clicking "Post" or "Send".
- Login and 2FA on LinkedIn: "take the wheel" handover.

**Answered:**
1. **Approval:** Aswin approves **every** item (posts, comments, replies, DMs, research) until the system works exactly like him. Autonomy is turned up per action type by Aswin, never automatically.
2. **ICM sample:** His existing `Content_writer` folder. Summary only on hand (not the files): `AGENTS.md` (interviews him on topic, experience, tone, format; routes research needs to RESEARCH.md), `RESEARCH.md` (live browser research; if a source is blocked, asks him for links or screenshots), `WRITER.md` (drafts, then runs the Humanizer skill, then formats for LinkedIn). **Real files still needed.**
3. **Content_Mind:** Both a folder of `.md` files and an Obsidian vault. Not built yet. He is building it ASAP.

**Design implication of answer 1 (proposed):**
- Every publish action starts at "ask every time" in `/bots/:id/approvals`, for each action type separately: post, comment, reply, DM.
- Each approve / edit / reject is saved as Learning evidence (section 10c).
- Raising a type to "automatic" is Aswin's decision only. The system may show approval-rate numbers to help him decide.

**Still open (needed for AGENT-SPEC.md):**
1. The real `Content_writer` folder (attach it, or put it in the repo), so the format is matched exactly. I will not guess.
2. Should the Manager only **read** Content_Mind, never write to it? (Proposed: read-only.)
3. How Content_Mind reaches the Bots is undecided. Each Bot has its own `/workspace` volume, so the vault is not visible by default. Options: copy or sync it in, mount it, or serve it through an MCP server. Not yet checked against OpenBot. Decide in the design phase.

**Risk, stated plainly:** LinkedIn's terms restrict automation, as far as I know. Posting and DMs from your real profile through a bot browser can get the account limited. Mitigations to build in: daily caps per action type, human-like pacing, and a kill switch.

---

## 11. Suggested phases (outline only, detailed plan comes in PLAN.md)

1. Pin repo + runtime versions. Get stock OpenBot running on Windows (WSL2).
2. Boot gate: add `postgres` mode, fix the 14 compile errors, run on the in-memory runner.
3. `PostgresAgentRunner` + `threads`, `thread_runs`, `thread_locks`.
4. Move routines and handoffs to the shared runner.
5. Browser app pass: history, reconnect, stop.
6. `PostgresMemory` (same interface as `IntelligenceMemory`), ranked recall with pgvector.
7. Automatic Learning on Postgres (section 10c): tables, `acquire`, then analyzer, then review panel.
8. Delete Intelligence code, vars, docs, tests. Update the Helm chart and compose file.
9. Security guard + isolation test (section 6). Required before any server / Google sign-in.
