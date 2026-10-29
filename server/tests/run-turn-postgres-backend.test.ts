import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, Message } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { EMPTY, Observable } from "rxjs";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { PostgresAgentRunner } from "../src/postgres-agent-runner";
import { createPostgresThreadBackend } from "../src/postgres-thread-backend";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * `createTurnRunner` against the REAL postgres `ThreadBackend`, rather than the hand-written fake of
 * `IntelligenceLike` every other test of this file exercises (`routine-run-turn.test.ts`). That file
 * is the lifecycle contract; this one is the seam Phase 3 asked for (docs/brooklyn/DECISIONS.md #26):
 * a routine firing, and an approval continuation resuming, with the lock and the history actually
 * backed by Postgres end to end, not a mock of the SDK's `ɵ`-prefixed shapes.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const access = createPostgresThreadBackend(database);

const OWNER = `run_turn_owner_${randomUUID().slice(0, 8)}`;
const AGENT_ID = "bot_helper";

let ownsUserFixture = false;

beforeAll(async () => {
  const [existing] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, OWNER))
    .limit(1);
  if (existing) return;
  ownsUserFixture = true;
  await database
    .insert(users)
    .values({ id: OWNER, email: `${OWNER}@openbot.test` });
});

afterAll(async () => {
  if (!ownsUserFixture) return;
  await database.delete(users).where(eq(users.id, OWNER));
});

function threadId() {
  return `run_turn_thread_${randomUUID()}`;
}

class FakeAgent extends AbstractAgent {
  // Never actually called: `createTurnRunner` drives the turn through `runner.run`, not `agent.run`.
  run() {
    return EMPTY;
  }
}

type Observer = {
  next: (event: { type: string }) => void;
  error: (error: unknown) => void;
  complete: () => void;
};

/** A minimal `RunnerLike`: it appends whatever the test wants onto the agent, then completes. */
function fakeRunner(drive: (agent: FakeAgent, observer: Observer) => void) {
  return {
    run: (request: { agent: unknown }) => ({
      subscribe: (observer: Observer) => {
        drive(request.agent as FakeAgent, observer);
        return { unsubscribe: () => undefined };
      },
    }),
    stop: async () => true,
  };
}

/** A real agent, for the tests below that go through the real `PostgresAgentRunner`, not a fake. */
class RealEventAgent extends AbstractAgent {
  events: BaseEvent[] = [];
  run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of this.events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

/** A realistic minimal AG-UI sequence, matching `postgres-agent-runner.test.ts`'s own helper. */
function happyPathEvents(threadId: string, runId: string): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "All set.",
    } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
  ];
}

describe("createTurnRunner against a real postgres ThreadBackend", () => {
  test("a routine's turn creates its thread, locks it, runs, and releases the lock", async () => {
    const id = threadId();
    const agent = new FakeAgent({ agentId: AGENT_ID });
    const runTurn = createTurnRunner({
      admission: serverTurnAdmission,
      intelligence: access,
      runner: fakeRunner((driveAgent, observer) => {
        driveAgent.messages = [
          ...driveAgent.messages,
          {
            id: "assistant_1",
            role: "assistant",
            content: "Three things happened.",
          },
        ] as typeof driveAgent.messages;
        observer.complete();
        // biome-ignore lint/suspicious/noExplicitAny: a narrow structural fake, on purpose.
      }) as any,
      buildAgentFor: async () => agent,
    });

    const result = await runTurn({
      ownerUserId: OWNER,
      routineId: "routine_standup",
      agentId: AGENT_ID,
      threadId: id,
      instruction: "Post the standup summary.",
    });

    expect(result.replyText).toBe("Three things happened.");
    await expect(
      access.getThread({ threadId: id, userId: OWNER }),
    ).resolves.toEqual({ id, userId: OWNER, agentId: AGENT_ID });
    // The lock was released: a fresh run id can take it straight away, not refused as still held.
    await expect(
      access.acquire({
        threadId: id,
        runId: randomUUID(),
        userId: OWNER,
        agentId: AGENT_ID,
      }),
    ).resolves.not.toBeNull();
  });

  test("an approval continuation resumes: the snapshot and the answer reach the Bot", async () => {
    const id = threadId();
    const agent = new FakeAgent({ agentId: AGENT_ID });
    const runTurn = createTurnRunner({
      admission: serverTurnAdmission,
      intelligence: access,
      runner: fakeRunner((driveAgent, observer) => {
        driveAgent.messages = [
          ...driveAgent.messages,
          { id: "assistant_1", role: "assistant", content: "Got it, done." },
        ] as typeof driveAgent.messages;
        observer.complete();
        // biome-ignore lint/suspicious/noExplicitAny: a narrow structural fake, on purpose.
      }) as any,
      buildAgentFor: async () => agent,
    });

    const snapshotMessages: Message[] = [
      { id: "u1", role: "user", content: "Email the report." },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "send_email", arguments: "{}" },
          },
        ],
      },
    ];

    const result = await runTurn({
      ownerUserId: OWNER,
      routineId: "routine_follow_up",
      agentId: AGENT_ID,
      threadId: id,
      instruction: "ignored for a continuation",
      continuation: {
        snapshot: {
          runId: "prior-run",
          threadId: id,
          toolCallId: "call_1",
          toolName: "send_email",
          args: {},
          messages: snapshotMessages,
          state: {},
          context: [],
          forwardedProps: {},
        },
        result: { content: "sent" },
        messageId: "tool_result_1",
      },
    });

    expect(result.replyText).toBe("Got it, done.");
    expect(agent.messages.map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "tool_result_1",
      "assistant_1",
    ]);
    expect(agent.messages[2]).toMatchObject({
      role: "tool",
      toolCallId: "call_1",
      content: "sent",
    });
  });
});

describe("createTurnRunner wired to the real PostgresAgentRunner, exactly as index.ts pairs them", () => {
  /*
   * `PostgresAgentRunner` manages its OWN lock internally (needed for the browser path, which has no
   * outer locker). `createTurnRunner` ALSO now takes a thread's lock itself via `access`. Pairing the
   * two without `externallyLocked: true` on the runner makes them collide on the same thread -- this
   * was caught in review before it shipped (Phase 3: docs/brooklyn/DECISIONS.md #28) -- so both sides
   * of that contract are pinned down here, against the real runner, not a fake one.
   */
  test("externally locked: the pairing completes a turn rather than colliding on the same lock", async () => {
    const id = threadId();
    const runId = randomUUID();
    const agent = new RealEventAgent({ agentId: AGENT_ID });
    agent.events = happyPathEvents(id, runId);
    const runTurn = createTurnRunner({
      admission: serverTurnAdmission,
      intelligence: access,
      runner: new PostgresAgentRunner(database, { externallyLocked: true }),
      buildAgentFor: async () => agent,
    });

    const result = await runTurn({
      ownerUserId: OWNER,
      routineId: "routine_real_runner",
      agentId: AGENT_ID,
      threadId: id,
      instruction: "Say something.",
      runId,
    });

    expect(result.replyText).toBe("All set.");
    // createTurnRunner's own release ran, and the runner did not also try to release underneath it.
    await expect(
      access.acquire({
        threadId: id,
        runId: randomUUID(),
        userId: OWNER,
        agentId: AGENT_ID,
      }),
    ).resolves.not.toBeNull();
  });

  test("without it, the pairing reproduces the collision: the turn fails with the runner's own lock refusal", async () => {
    const id = threadId();
    const runId = randomUUID();
    const agent = new RealEventAgent({ agentId: AGENT_ID });
    agent.events = happyPathEvents(id, runId);
    const runTurn = createTurnRunner({
      admission: serverTurnAdmission,
      intelligence: access,
      // The misconfiguration: omitting `externallyLocked`, so this runner also tries to take the
      // lock `access` already holds for this same run.
      runner: new PostgresAgentRunner(database),
      buildAgentFor: async () => agent,
    });

    await expect(
      runTurn({
        ownerUserId: OWNER,
        routineId: "routine_real_runner_misconfigured",
        agentId: AGENT_ID,
        threadId: id,
        instruction: "Say something.",
        runId,
      }),
    ).rejects.toThrow("Thread already running");
  });
});
