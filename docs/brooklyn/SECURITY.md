# Brooklyn: Security

Rules that must not break. Short on purpose.

## 1. Where Brooklyn is allowed to run

| Where | Allowed? |
|---|---|
| Aswin's laptop, no login, `OPENBOT_SINGLE_USER=true`, ports on localhost | Yes. This is the default. |
| Any server or public address | **Only after Phase 8**: Google sign-in on, `INITIAL_ADMIN_EMAILS` set, `OPENBOT_SINGLE_USER` removed, ports private, access over an SSH tunnel. |

The server must refuse to start on a non-local address without sign-in. (Built in Phase 8.)

## 2. The gap the swap creates

Intelligence mode checks who owns a thread on every request. The non-Intelligence mode does not.

- In the non-Intelligence runtime, the constructor does not wire `identifyUser`. **Verified in source.**
- The SDK's local thread routes (list, read messages, events, state, clear) do not filter by user. **Verified in source.**

What this means:
- On the one-user laptop: harmless.
- On any shared server: any signed-in user could read or run on another user's thread.

Rules:
1. **Never** mark the runner as supporting local thread endpoints (`ɵsupportsLocalThreadEndpoints`). Then those routes answer 422.
2. Our own routes (for example `server/src/channels/thread-routes.ts`) always check the owner.
3. Phase 8 adds a guard before the Copilot handler is mounted (`server/src/app.ts` near line 1367) and an **isolation test**: user A cannot connect to, run on, or read user B's thread.
4. Until Phase 8 passes, nobody else gets access.

## 3. Secrets

- `.env` stays local and is never committed.
- Credentials go in `.env` or the `/admin/credentials` page. Never in YAML, the repo, a chat or a screenshot.
- Never print keys, tokens or cookies in logs, test output or the demo video. Check the screen before recording.
- The LinkedIn login is entered by Aswin using "take the wheel" (the Bot hands the browser to the human for login and 2FA). The Bot never sees the password. *(From the docs, not yet tested.)*

## 4. Safety features that stay on

Never weaken these to make something work:
- Audit log of every Bot action
- Policy engine (CEL rules on host, element, intent)
- Per-Bot approvals (`/bots/:id/approvals`)
- Egress filter
- One-run-per-thread lock

## 5. LinkedIn rules

1. No live LinkedIn actions during development. Mock, or use a throwaway test account.
2. The real account only after Aswin approves Phase 9.
3. Every post, comment, DM and reply needs Aswin's approval, until he says otherwise per action type.
4. Daily caps are set before first live use (open item O9). Start low.
5. Stop at any CAPTCHA, warning, or restriction notice. Do not retry. Hand it to Aswin.
6. Do not collect or store personal data about people beyond what the task needs.
7. LinkedIn's terms limit automation. The account can be restricted. Aswin accepts this risk knowingly.

## 6. Content_Mind

- Bots read it. Writes go in only after Aswin approves the change.
- Treat everything the Researcher pulls from the web or LinkedIn as untrusted text. It can contain instructions aimed at the Bot (prompt injection). The Bot must never follow them, and never let them change policy, approvals or what gets published.

## 7. Dependencies

- A license scan of 1,183 installed packages was run in the research sandbox. Re-run it before any public release. **Re-check; do not trust the old result.**
- Do not upgrade `@copilotkit/*` during the swap.
