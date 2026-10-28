# Brooklyn: Decisions

Update this file at the end of every phase. Mark anything not tested as **unverified**.

## Decided (by Aswin)

| # | Decision |
|---|---|
| 1 | Base: `CopilotKit/OpenBot` (MIT, alpha), commit `ef13020`. `nightly-labs/openbot` is rejected (noncommercial license). |
| 2 | Remove CopilotKit Intelligence. Replace with plain Postgres. **Not optional, not skipped.** |
| 3 | **Automatic Learning stays.** Rebuilt on Postgres (Phase 6). |
| 4 | Memory keeps the same ranked recall Intelligence gives, with free open-source parts. |
| 5 | One user (Aswin). One process on his Windows laptop. `OPENBOT_SINGLE_USER=true`. |
| 6 | Order: swap first, then the LinkedIn agent, then restyle and demo. |
| 7 | Language: TypeScript. Build in Cursor. |
| 8 | Models: Claude and Codex for testing. API key (with a spend cap) for anything public. Provider stays a config setting. |
| 9 | Budget: $15 a month for API. |
| 10 | Product name: Brooklyn. Grok-Bot-like look and features. Chat groups with several agents talking to each other. |
| 11 | One vertical: LinkedIn management. Scope: posts, topic research, outreach DMs, comments, replies. |
| 12 | Team of three in one group: Writer, Researcher, Manager. See `AGENT-SPEC.md`. |
| 13 | Aswin has final approval on everything, until the agents work exactly like him. |
| 14 | The real LinkedIn account is shown on camera. |
| 15 | Expertise comes from `.md` files in Jake Van Clief's ICM method. |
| 16 | Manager reads and writes Content_Mind. Writes only after Aswin approves. |
| 17 | Aswin runs `/grill-with-docs`, `/to-spec`, `/to-tickets` before each phase and approves it. |
| 18 | Docs: CLAUDE.md, PLAN.md, ARCHITECTURE.md, DECISIONS.md, SECURITY.md, AGENT-SPEC.md. No DEMO.md. |
| 19 | No dates in the plan. Aswin manages the schedule. |
| 20 | Groups: keep OpenBot's "one thread per Bot plus shared transcript" design. |
| 21 | O1 resolved: WSL2, repo cloned fresh inside the WSL filesystem (`~/brooklyn` in the `Ubuntu` distro), not under `/mnt/c`. The OneDrive Windows copy is retired; all Phase 0+ work runs from the WSL clone. **Deviation from the proposed default:** Docker runs as a native Docker Engine installed directly inside the `Ubuntu` distro (`apt install docker.io docker-compose-v2`), not via Docker Desktop's WSL integration — Aswin's call, to skip the Docker Desktop Settings GUI step. Docker Desktop is still installed and can run alongside (separate daemon, no conflict observed). |
| 22 | O2 resolved: skip the hosted-Intelligence baseline run. Aswin: "Phase 2 is judged by the written contract and tests." |
| 23 | O3 resolved: `THREAD_BACKEND=postgres` locks in the new boot mode. Unset or `THREAD_BACKEND=intelligence` keeps today's behaviour (all 3 `INTELLIGENCE_*` vars required, partial set still errors). Any other value throws a clear boot error naming the bad value — no silent fallthrough. `.env.example` flips to ship postgres mode by default (the 3 `INTELLIGENCE_*` lines commented out, `THREAD_BACKEND=postgres` added); intelligence mode still works when someone explicitly configures it. |

## Decided (by the research)

| # | Decision | Why |
|---|---|---|
| R1 | Use the runtime's non-Intelligence mode with our own `PostgresAgentRunner`. | The SDK has a supported runner seam (4 methods). |
| R2 | Do not use the SDK's local thread endpoints. | They are not scoped per user. See `SECURITY.md`. |
| R3 | Do not use `@copilotkit/runtime/internal/*` or `ɵ` APIs in new code. | Private, may change without notice. |
| R4 | Reuse OpenBot's own seams: `IntelligenceLike`, `ThreadLock`, `IntelligenceMemory`, `AcquireLearnedSkills`. | Smallest change. |
| R5 | Docs live in `docs/brooklyn/`. | Repo already has `docs/architecture.md`, and Windows file names ignore case. |
| R6 | `AGENTS.md` added beside `CLAUDE.md`. | Cursor reads it. Aswin may delete it. |

## Still open (do not guess)

| # | Question | Decide in |
|---|---|---|
| O4 | Save run events only at run end, or flush during the run (crash safety). | Phase 2 |
| O5 | Embeddings: small local open-source model, or Postgres full-text search. Not tested on the 16 GB laptop. | Phase 5 |
| O6 | Analyzer spend cap and schedule for Learning. | Phase 6 |
| O7 | How Content_Mind reaches the Bots: copy/sync, mounted folder, or MCP. | Phase 9 |
| O8 | When a Bot may act without Aswin's approval (graduation rules). | Phase 9 |
| O9 | Daily LinkedIn action caps (posts, DMs, comments). | Phase 9 |
| O10 | The real `Content_writer` folder and a sample ICM file. Not yet shared. | Phase 9 |
| O11 | Restyle details and demo plan. | Phase 10 |

## Risks to keep in view

| Risk | Note |
|---|---|
| LinkedIn terms restrict automation | Account can be limited or banned. Aswin's real account is at stake. Keep volumes low. Approval gates stay on. |
| Anthropic plan use | Whether using the Claude plan inside OpenBot is allowed was **not verified**. Check the current terms before relying on it. API key is the safe path. |
| Learning cost | The analyzer spends tokens against the $15 budget. Needs a cap. |
| Alpha base | OpenBot is alpha. Do not pull upstream mid-swap. |
| Free CopilotKit plan | Non-production only, 1,000 interactions per month. Only matters if we use the hosted baseline in Phase 0. |
| Browser app in new mode | Untested until Phase 4. |
| Windows Docker socket | The supervisor needs it. The native-in-WSL Docker Engine works for Postgres; the supervisor's own socket access is still untested (first exercised when `supervisor` itself runs, later phase). |
| WSL distro idle shutdown | A WSL distro instance (not just the outer VM) powers off ~15-30s after the last attached process exits, killing any running containers with it. `vmIdleTimeout=-1` in `.wslconfig` does **not** fix this (it only governs the outer VM). Workaround: keep one long-lived process attached to the distro (e.g. `wsl -d Ubuntu -- bash -lc 'tail -f /dev/null'` running in the background) for the whole duration anything inside WSL needs to stay up. Matters for every later phase that drives the stack from short-lived shell invocations. |

## Phase log

Add one line per finished phase: date, phase, what changed, test results, anything surprising.

- Phase 0 (2026-10-27): Fork bookkeeping done — tag `base-ef13020` and branch `brooklyn-base` at commit `ef13020`, pushed to `origin`; `upstream` remote added (`CopilotKit/OpenBot`, push disabled). Repo re-cloned fresh into `~/brooklyn` inside WSL2 (`Ubuntu` distro); the OneDrive Windows copy is retired. Bun installed and pinned to `1.4.3` (matches `packageManager` in `package.json`). `bun install`: 1181 packages, clean. `typecheck`: green across all 5 workspaces. `lint` (biome, `--error-on-warnings`): green, 1635 files. `test` baseline (before Postgres was up): 6506 pass, 142 fail, 81 skip, 131 errors, 6729 tests across 722 files in 232s — failures traced to missing `TEST_DATABASE_URL`/Postgres, no Docker on `agent-computer`'s subprocess `$PATH` at that point, a few optional-workspace deps not installed (`web-bot-auth`, `@ag-ui/core`, `@langchain/anthropic`, desktop/Tauri deps), and live-network/credentialed tests — none are regressions, all pre-existing environment gaps. Docker: installed natively inside WSL (`docker.io` + `docker-compose-v2`), not via Docker Desktop's WSL integration (see decision #21). `docker compose up -d postgres` then `docker compose run --rm migrate`: succeeded, 92 tables confirmed in the `openbot` database. `gh` CLI installed (winget) and authenticated as `codaswin`. Surprising: a WSL distro instance fully powers off between separate short-lived command invocations unless something stays attached — see the new risk row above. **Confirmed done by Aswin on 2026-10-28.**
- Phase 1, ticket #2 (2026-10-28): `THREAD_BACKEND=postgres` boots the server end-to-end. `config.ts`'s `RuntimeCapabilities` is a real union now; the boot-gate rules from decision #23 are implemented and tested directly (`config.test.ts`). `copilot.ts`'s `mountCopilotRuntime` gets an explicit postgres branch on the SDK's `InMemoryAgentRunner`, with a named `CopilotRuntimeMount` return type so both branches type-check against one contract rather than inferring a union. The bigger-than-expected finding: the shared headless-turn pair (`routineIntelligence`/`routineAgentRunner` in `index.ts`) backs not just routines but 7 more features (responsibilities, approval-continuation resumption, proactive suggestions, wake-ups, channel-naming, delivery-channel history) — guarding all of them off individually would have meant touching 15+ sites including several persistent background loops. Chose the smaller fix instead: construct that pair with inert placeholder settings in postgres mode, so every consumer stays untouched; none of them work yet in postgres mode (nothing to dial), but nothing is pre-vetoed either. `typecheck`/`lint`: green in both modes. New tests: 167/167. Full suite: 141 fail / 6529 pass (vs Phase 0's 142/6506) — no new regressions, same pre-existing categories. **Process mistake, caught and fixed in the same session:** merged PR #4 to `main` before realizing the actual code was still uncommitted locally — PR #4 only carried the earlier docs commit. Committed the real implementation, opened PR #5, merged that too. PR #4's body also said "Closes #1", which auto-closed the *parent* tracking issue on merge — against `to-tickets`' own rule not to close parent issues. Reopened #1. Ticket #3 (the `.env.example`/`docker-compose.yml`/`scripts/start.sh` default-flip) is still open and not started.
- Phase 1, ticket #3 (2026-10-28): `.env.example` ships `THREAD_BACKEND=postgres` by default, the three `INTELLIGENCE_*` lines commented out rather than deleted, no real secret in the file. `docker-compose.yml` needed no change — it never referenced the three Intelligence variables (the server isn't a compose service; `migrate` runs standalone and never loads `config.ts`). `scripts/start.sh`'s runtime-health step only checks `licenseStatus` when the response actually carries one — the SDK only includes it for an Intelligence runtime. Caught two real bugs by actually booting the server in postgres mode rather than stopping at typecheck/lint/tests: the placeholder `CopilotKitIntelligence` settings from ticket #2 used a blank `apiKey`, which the SDK's own constructor refuses; and `startHandoffDelivery` was still called unconditionally at boot (gated only on `config.handoff.maxDepth`/`maxPerRun`, not mode), eagerly calling `copilotRuntime.runnerConnection()` during its own setup rather than lazily on first use — now also gated on intelligence mode. Manually verified end to end: `cp .env.example .env && bash scripts/start.sh` boots in postgres mode (after installing a missing `docker buildx` plugin, an unrelated tooling gap, fixed user-locally with no sudo); `/health` and `/api/copilotkit/info` both answer correctly with no license status present. Both tickets for Phase 1 are now closed; the parent issue #1 stays open per `to-tickets`' rule, awaiting Aswin's confirmation the same way Phase 0 did.
