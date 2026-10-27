# Brooklyn: Build Plan

Phases run **in order, one at a time.** No dates. Aswin owns the schedule.

**Before each phase:** Aswin runs `/grill-with-docs`, `/to-spec`, `/to-tickets`. The coding agent starts only after Aswin says "go".
**After each phase:** run `bun run typecheck`, `bun run lint`, `bun test`. Update `DECISIONS.md`. Aswin says "done".

Line numbers below are for base commit `ef13020`. They will drift as we edit. Search by name if a number is off.
The outline in `INTELLIGENCE-REPLACEMENT.md` section 11 is replaced by this plan.

| # | Phase | Result |
|---|---|---|
| 0 | Fork and baseline | Own fork, toolchain proven on Windows |
| 1 | Boot gate | Server starts with no Intelligence |
| 2 | Postgres threads | History survives a restart |
| 3 | Routines and hand-offs | They run on the shared Postgres runner |
| 4 | Browser app pass | The UI works end to end |
| 5 | Postgres memory | Ranked recall, free and local |
| 6 | Automatic Learning | Rebuilt on Postgres |
| 7 | Remove Intelligence | No trace left in code, config or docs |
| 8 | Security guard | Safe to put on a server |
| 9 | LinkedIn agent team | Writer, Researcher, Manager |
| 10 | Restyle and demo | Looks like Brooklyn |

---

## Phase 0: Fork and baseline (no code changes)

**Goal:** A fork Aswin owns, with a toolchain that is proven to work on his laptop.

**Do:**
1. Fork `CopilotKit/OpenBot`. Clone it. Create branch `brooklyn-base` at commit `ef13020` and tag it `base-ef13020`.
2. Keep an `upstream` remote. Do not pull from it.
3. Install: Git, Bun (the repo declares `bun@1.4.3`), Docker Desktop with the WSL2 backend.
4. Put the repo inside WSL2 (for example `~/brooklyn`). Open it in Cursor through its WSL connection. *(Unverified. If it fails, record why in `DECISIONS.md`.)*
5. `bun install`, then `cp .env.example .env`.
6. Run `bun run typecheck`, `bun run lint`, `bun test`. **Record the exact results.** Any test that fails before we change anything is not ours. List them in `DECISIONS.md`.
7. Start only the database and run migrations: `docker compose up -d postgres`, then `docker compose run --rm migrate`. Confirm Postgres answers on 5432.

**Do not run `scripts/start.sh` yet.** The server refuses to start until Phase 1.

**Optional (Aswin decides):** One baseline run on the free hosted Intelligence plan, to record how stock OpenBot behaves. It becomes the reference for Phase 2 tests. Free plan is non-production only and capped at 1,000 interactions per month.

**Done when:** Fork exists. Baseline test results are written down. Postgres + migrations work. WSL2 decision is recorded.

---

## Phase 1: Boot gate

**Goal:** `THREAD_BACKEND=postgres` boots the server with none of the three Intelligence variables set. Conversations live in memory for now (lost on restart). That is expected.

**Work:**
1. `server/src/config.ts`, function `runtimeCapabilities`:
   - Make `RuntimeCapabilities` a union: `mode: "intelligence"` (as today) or `mode: "postgres"` with no `intelligence` settings.
   - When `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY` are **all absent** and `THREAD_BACKEND=postgres`, return `postgres` mode.
   - **A partial set of the three stays an error.** `THREAD_BACKEND` is a proposed name.
2. Fix the 14 compile errors this causes (tested in a scratch clone at `ef13020`):

   | File | Lines |
   |---|---|
   | `server/src/app.ts` | 1934 |
   | `server/src/copilot.ts` | 1749, 1750, 1751, 1787 |
   | `server/src/index.ts` | 343, 352, 377, 378, 692, 693, 694, 1245, 2361 |

3. `server/src/copilot.ts` near line 1777: in `postgres` mode, build `CopilotRuntime` **without** `intelligence`, with a `runner`. Do **not** pass `channels` or `ɵlearning` (the runtime throws in this mode).
4. Replace `new IntelligenceAgentRunner(...)` at `server/src/index.ts` near line 1651 and `server/src/agents/handoff-wiring.ts` near line 126 with one shared runner.
5. For now the shared runner is the SDK's `InMemoryAgentRunner` (confirm the export path in the installed package).
6. In `postgres` mode: pass no `intelligence` to `createMemoryStore` (it is optional), leave learning off, skip the entitlement check and the self-host banner.
7. Update `.env.example`, `docker-compose.yml` and `scripts/start.sh` so the three variables are not required in `postgres` mode. Keep `intelligence` mode working until Phase 7.
8. Update config tests. Add tests: all three absent + `postgres` boots; a partial set fails.

**Open check:** The SDK's non-Intelligence runtime does not use `identifyUser` (seen in the runtime source). Find out what this means for how OpenBot identifies the user, and write it in `SECURITY.md`.

**Done when:** `THREAD_BACKEND=postgres bash scripts/start.sh` boots. `/health` answers. Aswin can open the UI, start a chat, get a reply. Typecheck, lint and tests are green in both modes.

---

## Phase 2: Postgres threads, runs and locks

**Goal:** Conversations survive a restart.

**Work:**
1. Define a `ThreadBackend` interface shaped like the existing `IntelligenceLike` in `toolkit/src/run-turn.ts` plus the `ThreadLock` in `toolkit/src/ports.ts`:
   - `getOrCreateThread({threadId, userId, agentId})`: idempotent
   - `getThread({threadId, userId})`: missing means "unknown"
   - `getThreadMessages({threadId, userId})`: returns `{messages:[{id, role, content, activityType, toolCalls[{id,name,args}], toolCallId}]}`
   - lock `acquire` (null when held), `renew`, `release`
2. Drizzle migration for `threads`, `thread_runs`, `thread_locks` (columns in `ARCHITECTURE.md`).
3. `PostgresAgentRunner extends AgentRunner` with `run`, `connect`, `isRunning`, `stop`. Use the SDK's `InMemoryAgentRunner` as the template and `IntelligenceAgentRunner.run` for the event rules (both are readable inside the installed `@copilotkit/runtime` package, folder `dist/v2/runtime/runner/`):
   - set `agent.threadId`, call `agent.runAgent(input, {onEvent})`
   - guarantee a `RUN_STARTED` event that carries `persistedInputMessages`
   - on failure push `RUN_ERROR`
   - always end with `finalizeRunEvents`
   - `connect` replays stored events, then follows the live run
   - **Do not** mark the runner as supporting local thread endpoints (`ɵsupportsLocalThreadEndpoints`). See `SECURITY.md`.
4. Lock: one row per thread. Acquire fails if another run holds an unexpired lease. TTL 120 s. Expired leases can be taken over.
5. Wire it as the shared runner from Phase 1 and as the `ThreadBackend`.

**Decide in the grill session:** Save events only when a run ends (like the in-memory runner), or also flush while it runs, so a crash mid-run loses less?

**Tests (write first):** replay equals what was streamed; second concurrent run is refused; stop works; failure ends with `RUN_ERROR`; history survives killing and restarting the server; an expired lock can be taken; renew by the wrong run id fails.

**Done when:** Restart the server mid-conversation and the history is intact. All tests green.

---

## Phase 3: Routines and hand-offs

**Goal:** Scheduled runs and Bot-to-Bot hand-offs use the Postgres runner and lock.

**Work:** `createTurnRunner` (in `toolkit/src/run-turn.ts`) takes the `ThreadBackend` and shared runner in `postgres` mode. Same for `handoff-wiring.ts`. Group threads (`group_bot_threads`) stay as they are.

**Done when:** A routine fires and its reply lands in the right channel. Bot A hands work to Bot B and B answers in its own thread. A 3-Bot group works. A busy thread makes a hand-off wait, not fail.

---

## Phase 4: Browser app pass

**Goal:** The UI behaves in the new mode. This part is **untested so far**.

**Manual checklist (Aswin runs it):** new channel; send; reload mid-reply (it reconnects and keeps following); Stop button; restart server then reopen the chat; group chat with 2 Bots; direct `/bot` chat; the "does this thread still exist" check (`server/src/channels/thread-routes.ts`, backed by `ThreadBackend.getThread`); memory page. Also open the browser network panel: **no calls to any CopilotKit-hosted address.**

**Likely files:** `app/src/lib/copilot/bot-thread.ts`, `app/src/lib/copilot/provider.tsx`, `app/src/routes/_authed/_app/bot.tsx`.

**Done when:** Every checklist item passes and the network check is clean.

---

## Phase 5: Postgres memory

**Goal:** Ranked recall like Intelligence gives, free and local.

**Background (verified):** Without Intelligence, recall is a plain substring match. Postgres already has the `vector` extension (image `pgvector/pgvector:pg17`). Nothing uses it yet.

**Work:** Implement `PostgresMemory` with the same interface as `IntelligenceMemory` in `server/src/memory/intelligence.ts`: `available`, `list`, `recall`, `create`, `supersede`, `remove`. Pass it in the same slot: `createMemoryStore(db, { intelligence })`. The store code does not change. Keep user-scope only (never project-scope).

**Decide in the grill session:** How to make embeddings for free. Options: a small local open-source embedding model, or Postgres full-text search as a no-model fallback. **Not yet checked on a 16 GB laptop.**

**Done when:** Memory page works. A test set shows semantic recall beating substring match. No outbound calls.

---

## Phase 6: Automatic Learning on Postgres

**Goal:** Learning kept, rebuilt. Design in `INTELLIGENCE-REPLACEMENT.md` section 10c.

**Work, in this order:**
1. Tables: `learning_evidence`, `learning_candidates`, `learning_skills`, `learning_skill_revisions`. Keep `learning_settings` and `learning_thread_bindings`.
2. **Delivery first:** implement `AcquireLearnedSkills` over Postgres (`server/src/learning/runtime.ts`). Return `{catalog, tools, execute}` with the two tools `copilotkit_load_skill` and `copilotkit_read_skill_file`. Build it ourselves. Do **not** use `@copilotkit/runtime/internal/learned-skills`. `copilot.ts` needs no change.
3. **Evidence:** threads, plus Manager verdicts and **Aswin's approve / edit / reject**.
4. **Analyzer:** scheduled job on the existing `work_items` queue. A model reads recent evidence and writes skill candidates as `.md`.
5. **Review panel** on `/admin/learning`: approve, edit, reject. Approve creates a numbered revision. **Nothing auto-publishes.**
6. Delete `learning/ensure-container.ts`, `learning/auto-assign.ts`, `scripts/setup-learning.ts`, `scripts/self-hosted-learning.ts`.

**Rules:** Hand-written ICM files beat a learned skill if they disagree. The analyzer needs a spend cap (monthly API budget is $15) and runs on a button or a daily schedule, never per thread.

**Done when:** An approved candidate appears in the catalog of the next run. A rejected one never does. The analyzer stops at its cap.

---

## Phase 7: Remove Intelligence

**Goal:** No Intelligence left.

**Work:** Delete `server/src/intelligence-client.ts`, `server/src/intelligence-entitlement-check.ts`, `server/src/self-host-banner.ts`, `server/src/memory/intelligence.ts` (once `PostgresMemory` replaces it), Intelligence thread-lock code, the three `INTELLIGENCE_*` variables everywhere (`.env.example`, compose, `scripts/start.sh`, `charts/`, `desktop/`, `docs/`), and tests that exist only for Intelligence. Drop `intelligence` mode from `config.ts`. Optionally rename `intelligence_channel_mappings` with a migration.

**Done when:** `grep -ri intelligence` finds only migration history and the changelog. Stack boots from a clean clone. All green.

---

## Phase 8: Security guard

**Goal:** Safe to run on a server. Details in `SECURITY.md`.

**Work:** Ownership check before the Copilot handler is mounted (`server/src/app.ts` near line 1367). Isolation test: user A cannot connect to, run on, or read user B's thread. Turn on Google sign-in, set `INITIAL_ADMIN_EMAILS`, remove `OPENBOT_SINGLE_USER`.

**Done when:** The isolation test passes and the server refuses to start on a public address without sign-in.

---

## Phase 9: LinkedIn agent team

**Goal:** Writer, Researcher, Manager as one group. Spec in `AGENT-SPEC.md` (draft, has open items).

**Needs from Aswin first:** the real `Content_writer` folder, the Content_Mind plan, per-action caps.

**Done when:** Spec is finished and approved, then built phase by phase with approval on every action.

---

## Phase 10: Restyle and demo

**Goal:** Brooklyn looks like Brooklyn (Grok-Bot style, live view of the Bot's screen). Demo video.

Needs its own grill session. Use `.claude/skills/openbot-screen-layout` and `openbot-copy`. Details: TBD.
