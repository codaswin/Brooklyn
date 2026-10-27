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
| O1 | WSL2 or native Windows for running the stack. Default: WSL2 + Docker Desktop, repo inside WSL. | Phase 0 |
| O2 | Run one baseline on the free hosted Intelligence plan, or skip. | Phase 0 |
| O3 | Env name for the new mode. Proposed: `THREAD_BACKEND=postgres`. | Phase 1 |
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
| Windows Docker socket | The supervisor needs it. Untested until Phase 0. |

## Phase log

Add one line per finished phase: date, phase, what changed, test results, anything surprising.

- Phase 0: pending.
