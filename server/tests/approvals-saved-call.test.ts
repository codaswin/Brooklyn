import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { savedToolCall } from "../src/approvals/wiring";
import { createDatabase } from "../src/db/client";
import { threadRuns, users } from "../src/db/schema";
import { createPostgresThreadBackend } from "../src/postgres-thread-backend";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

// What the browser asks to run: the Bot's click, as the live stream delivered it whole.
const snapshot = {
  toolCallId: "call_trzjXH0dFVyoivzeFqY2kn4D",
  toolName: "computer_click",
  args: { ref: "f2e94", snapshotId: 7 },
};

/** The conversation as Intelligence returns it, holding the click with these saved arguments. */
const conversation = (args: string | null, answered = false) =>
  ({
    messages: [
      ...(args === null
        ? []
        : [
            {
              id: "1941c748-b06c-4cf6-89f0-a8904e89b22c",
              role: "assistant",
              toolCalls: [
                { id: snapshot.toolCallId, name: "computer_click", args },
              ],
            },
          ]),
      ...(answered
        ? [{ id: "result", role: "tool", toolCallId: snapshot.toolCallId }]
        : []),
    ],
  }) as never;

/** Each read returns the next saved state, then keeps returning the last. */
const reads = (...states: never[]) => {
  let index = 0;
  return async () => states[Math.min(index++, states.length - 1)]!;
};
const noWait = { sleep: async () => {} };

describe("the saved copy of a call the browser is about to run", () => {
  test("a call read while its arguments are still being saved is waited for, not refused", async () => {
    // Intelligence saves a call's arguments delta by delta, behind the stream: a read can land
    // after the call starts and before its arguments end. The first reads here are what run 112
    // of the Kite demo held part-way through: half the JSON, then all of it but the last key.
    const saved = await savedToolCall(
      reads(
        conversation('{"ref":"f2e'),
        conversation('{"ref":"f2e94"}'),
        conversation('{"ref":"f2e94","snapshotId":7}'),
      ),
      snapshot,
      noWait,
    );
    expect(saved).toEqual({ matches: true, answered: false });
  });

  test("a call that never appears, or never matches, is still refused once the wait runs out", async () => {
    expect(
      await savedToolCall(reads(conversation(null)), snapshot, noWait),
    ).toMatchObject({ matches: false });
    expect(
      await savedToolCall(
        reads(conversation('{"ref":"e12","snapshotId":7}')),
        snapshot,
        noWait,
      ),
    ).toMatchObject({ matches: false });
    expect(
      await savedToolCall(reads(conversation('{"ref":"f2e')), snapshot, noWait),
    ).toMatchObject({ matches: false });
  });

  test("a call that already has a result is reported as answered", async () => {
    expect(
      await savedToolCall(
        reads(conversation('{"ref":"f2e94","snapshotId":7}', true)),
        snapshot,
        noWait,
      ),
    ).toEqual({ matches: true, answered: true });
  });
});

/*
 * Every test above reads from a hand-written fake. `createServerApprovalService`'s own resume path
 * calls `savedToolCall` with a `read` backed by `ThreadReader` (`IntelligenceLike` or `ThreadBackend`
 * — Phase 3, ticket #28: docs/brooklyn/DECISIONS.md #30), so this is the one test confirming a real
 * postgres-mode thread's seeded tool call is found and matched, not just a fake's.
 */
describe("the saved copy of a call, read through the real postgres ThreadBackend", () => {
  const database = createDatabase(testDatabaseUrl(), TEST_POOL);
  const backend = createPostgresThreadBackend(database);
  const userId = `approvals_saved_call_user_${randomUUID().slice(0, 8)}`;
  let ownsUserFixture = false;

  beforeAll(async () => {
    const [existing] = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (existing) return;
    ownsUserFixture = true;
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@openbot.test` });
  });

  afterAll(async () => {
    if (!ownsUserFixture) return;
    await database.delete(users).where(eq(users.id, userId));
  });

  test("matches a tool call seeded as a real run, and reports it unanswered", async () => {
    const threadId = `approvals_saved_call_thread_${randomUUID()}`;
    await backend.getOrCreateThread({ threadId, userId, agentId: "default" });
    await database.insert(threadRuns).values({
      threadId,
      runId: randomUUID(),
      agentId: "default",
      events: [],
      messages: [
        {
          id: "a1",
          role: "assistant",
          toolCalls: [
            {
              id: snapshot.toolCallId,
              name: snapshot.toolName,
              args: JSON.stringify(snapshot.args),
            },
          ],
        },
      ],
    });

    const saved = await savedToolCall(
      () => backend.getThreadMessages({ threadId, userId }),
      snapshot,
      noWait,
    );

    expect(saved).toEqual({ matches: true, answered: false });
  });
});
