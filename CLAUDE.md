# Brooklyn: rules for the coding agent

Brooklyn is Aswin's fork of **CopilotKit/OpenBot** (MIT, alpha), base commit `ef13020`, runtime `@copilotkit/runtime` **1.77.0**.
Goal: remove CopilotKit Intelligence (hosted) and replace it with plain Postgres, then build one LinkedIn vertical agent team on top.

**Read these first, in this order:**
1. `docs/brooklyn/DECISIONS.md` (what is already decided)
2. `docs/brooklyn/PLAN.md` (the phases)
3. `docs/brooklyn/ARCHITECTURE.md` (how it fits together)
4. `docs/brooklyn/SECURITY.md` (rules that must not break)
5. `docs/brooklyn/AGENT-SPEC.md` (the LinkedIn agent, later phases)
6. `docs/brooklyn/INTELLIGENCE-REPLACEMENT.md` (research behind the swap)

---

## Rules (not optional)

1. **One phase at a time.** Work only on the phase Aswin names. Do not start the next phase.
2. **Aswin approves each phase before you start.** He runs `/grill-with-docs`, `/to-spec`, `/to-tickets` first. Follow what they produce. Do not move their output files.
3. **Stay inside the phase's file list** in `PLAN.md`. Need another file? Stop and ask.
4. **Do not guess.** If it is not in the docs or the code, ask. Mark anything unverified as "unverified".
5. **Keep code short and simple.** Pure logic, small functions, no extra layers. Plain English in comments.
6. **After every change, run:** `bun run typecheck`, `bun run lint`, `bun test`. Report the result. Never say "done" with a red check.
7. **Tests first** for the runner, the thread lock, memory and learning. These are the risky parts.
8. **No `ɵ`-prefixed SDK internals in new code.** They are the private parts of the SDK. We are removing our dependence on them.
9. **Never commit secrets.** `.env` stays local. Credentials go in `.env` or the `/admin/credentials` page. Never in YAML, the repo, or chat.
10. **Do not pull upstream.** OpenBot is alpha and changes daily. Only Aswin decides to merge upstream.
11. **Never weaken safety features** (audit, policy, approvals, egress filter) to make something work.
12. **No live LinkedIn actions** during development. Use mocks or a throwaway test account. Real-account use starts only when Aswin approves Phase 9.

---

## Commands (from the repo's own `package.json` and README)

| Do | Command |
|---|---|
| Install | `bun install` |
| Make local config | `cp .env.example .env` |
| Types | `bun run typecheck` |
| Lint | `bun run lint` |
| Format check | `bun run format:check` |
| Tests | `bun test` (runs `generate:app-config` first, which needs `.env`) |
| Build | `bun run build` |
| New DB migration | `bun run --filter server db:generate` then `bun run --filter server db:migrate` |
| Whole stack | `bash scripts/start.sh` (stop: `bash scripts/stop.sh`) |
| App + server only | `bun run dev` |

Ports: app 3010, server 3001, agent-computer 4100, supervisor 4500, Postgres 5432.
Server entry used by `start.sh`: `server/src/production-entry.ts`.

---

## Layout (what matters for the swap)

| Path | What it is |
|---|---|
| `server/src/config.ts` | Boot gate. Refuses to start without Intelligence today |
| `server/src/copilot.ts` | Builds the CopilotKit runtime and the Bots |
| `server/src/index.ts` | Wiring: routines, handoffs, memory, learning |
| `server/src/app.ts` | HTTP routes. Mounts the Copilot handler near line 1367 |
| `server/src/agents/handoff-wiring.ts` | Bot-to-Bot hand-offs |
| `server/src/channels/` | Channels, groups, thread ids, thread status |
| `server/src/memory/` | Memory store and the Intelligence adapter |
| `server/src/learning/` | Automatic Learning |
| `toolkit/src/run-turn.ts`, `toolkit/src/copilotkit/thread-lock.ts` | Headless runs and the thread lock |
| `toolkit/src/ports.ts` | Narrow interfaces we reuse as seams |
| `app/` | React app |
| `agent-computer/`, `supervisor/` | Per-Bot browser computers |
| `.claude/skills/` | The repo's own skills: `openbot-data-access`, `openbot-screen-layout`, `openbot-copy`. Use them when touching data access, layout or UI copy |

---

## Windows notes

- Aswin builds on a Windows laptop in Cursor.
- `scripts/start.sh` is bash and the supervisor needs the Docker socket. Default plan: WSL2 + Docker Desktop (WSL2 backend), repo kept **inside the WSL filesystem**, not under `/mnt/c`. Phase 0 confirms this works. It is not verified yet.
- Windows file names are not case-sensitive. Never add a file whose name differs from an existing one only by case.

---

## A phase is done only when

- Everything in its "Done when" list in `PLAN.md` is true and shown, not claimed.
- `typecheck`, `lint` and `test` are green.
- `DECISIONS.md` is updated with anything newly decided.
- Aswin has said it is done.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `codaswin/Brooklyn`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
