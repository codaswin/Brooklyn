import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { Observable } from "rxjs";
import { createActorAgentResolver } from "../src/agents/agent-resolver";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { HandoffWork } from "../src/agents/handoff-runner";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createStallGuard } from "../src/channels/stall-guard";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema";
import { testEnvironment } from "./support/environment";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * `createHandoffDelivery` wired to the REAL postgres-mode `copilotRuntime` -- the thread-lock,
 * history and runner `mountCopilotRuntime` used to answer with throwing stand-ins in postgres mode
 * (Phase 1), now real (Phase 3, ticket #22). Every other test of `handoff-delivery.ts`
 * (`agent-handoff-delivery.test.ts`) exercises its lifecycle logic against hand-written fakes of
 * those three; this file is the seam the ticket actually asked for.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const OWNER = `handoff_owner_${randomUUID().slice(0, 8)}`;

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

function scratchThreadId() {
  return `handoff_scratch_${randomUUID()}`;
}

/** A real agent, so the real `PostgresAgentRunner` behind `copilotRuntime.runner` has one to drive. */
class RealEventAgent extends AbstractAgent {
  events: BaseEvent[] = [];
  run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      for (const event of this.events) subscriber.next(event);
      subscriber.complete();
    });
  }
}

function happyPathEvents(threadId: string, runId: string): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "Found it: 2am to 4am.",
    } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
  ];
}

function mountPostgresRuntime() {
  const guard = createStallGuard({ stallMs: 0 });
  const runtime = mountCopilotRuntime(
    loadConfig(testEnvironment({ THREAD_BACKEND: "postgres" })),
    database,
    createActorAgentResolver({
      model: { provider: "openai", defaultModel: "unused" },
      loadAgents: async () => [],
      resolveModelApiKey: async () => null,
      stallGuard: guard,
    }),
    async () => ({ id: OWNER, name: "Owner" }),
    async () => ({ id: OWNER, role: "user" }),
  );
  return { runtime, stop: () => guard.stop() };
}

const WORK: HandoffWork = {
  fromBotId: "assistant",
  toBotId: "researcher",
  actorId: OWNER,
  threadId: "asking-thread",
  runId: "asking-run",
  depth: 1,
  task: "find the outage window",
};

describe("createHandoffDelivery against the real postgres-mode copilotRuntime", () => {
  test("a hop runs the addressed Bot in its own scratch thread, locks it and releases it", async () => {
    const { runtime, stop } = mountPostgresRuntime();
    try {
      const id = scratchThreadId();
      const runId = randomUUID();
      const agent = new RealEventAgent({ agentId: WORK.toBotId });
      agent.events = happyPathEvents(id, runId);

      const delivery = createHandoffDelivery({
        admission: serverTurnAdmission,
        agentFor: async () => agent,
        history: runtime.history,
        lock: runtime.threadLock,
        runner: runtime.runner as never,
        mintThreadId: () => id,
        newRunId: () => runId,
      });

      const result = await delivery.deliver({
        work: WORK,
        message: "assistant has asked you to help",
        shown: "Assistant asked Researcher for this on your behalf",
        assertion: "signed",
      });

      expect(result.answer).toContain("Found it: 2am to 4am.");
      // Released: a fresh run id can take the scratch thread's lock straight away.
      await expect(
        runtime.threadLock.acquire({
          threadId: id,
          runId: randomUUID(),
          userId: OWNER,
          agentId: WORK.toBotId,
        }),
      ).resolves.not.toBeNull();
    } finally {
      stop();
    }
  });

  test("a scratch thread somebody else is already running in is waited for, not failed", async () => {
    const { runtime, stop } = mountPostgresRuntime();
    try {
      const id = scratchThreadId();
      // Somebody else's live hold on the exact thread this hop is about to be minted into.
      await runtime.threadLock.acquire({
        threadId: id,
        runId: randomUUID(),
        userId: OWNER,
        agentId: WORK.toBotId,
      });

      const agent = new RealEventAgent({ agentId: WORK.toBotId });
      const delivery = createHandoffDelivery({
        admission: serverTurnAdmission,
        agentFor: async () => agent,
        history: runtime.history,
        lock: runtime.threadLock,
        runner: runtime.runner as never,
        mintThreadId: () => id,
        newRunId: () => randomUUID(),
      });

      await expect(
        delivery.deliver({
          work: WORK,
          message: "m",
          shown: "s",
          assertion: "s",
        }),
      ).rejects.toThrow("busy");
    } finally {
      stop();
    }
  });
});
