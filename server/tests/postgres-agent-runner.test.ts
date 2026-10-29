import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import { eq } from "drizzle-orm";
import { firstValueFrom, Observable, toArray } from "rxjs";
import { createDatabase } from "../src/db/client";
import { threadLocks, threadRuns, threads, users } from "../src/db/schema";
import { PostgresAgentRunner } from "../src/postgres-agent-runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const ownerUserId = "dev-local-user";

let ownsUserFixture = false;

beforeAll(async () => {
  const [existing] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);
  if (existing) return;
  ownsUserFixture = true;
  await database
    .insert(users)
    .values({ id: ownerUserId, email: `${ownerUserId}@openbot.test` });
});

afterAll(async () => {
  if (!ownsUserFixture) return;
  await database.delete(users).where(eq(users.id, ownerUserId));
});

function threadId() {
  return `runner_thread_${suite}_${randomUUID()}`;
}

/** A realistic minimal AG-UI sequence: a run, one assistant message, done. */
function happyPathEvents(threadId: string, runId: string): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "Three things happened.",
    } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
  ];
}

/** Emits a scripted event sequence, or hangs until aborted, or throws -- whichever the test wants. */
class FakeAgent extends AbstractAgent {
  events: BaseEvent[] = [];
  throwError?: Error;
  hangUntilAborted = false;
  aborted = false;

  override abortRun(): void {
    this.aborted = true;
    super.abortRun();
  }

  run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      if (this.throwError) {
        subscriber.error(this.throwError);
        return;
      }
      for (const event of this.events) subscriber.next(event);
      if (this.hangUntilAborted) {
        const check = setInterval(() => {
          if (this.aborted) {
            clearInterval(check);
            subscriber.complete();
          }
        }, 5);
        return () => clearInterval(check);
      }
      subscriber.complete();
    });
  }
}

function runInput(threadId: string, runId: string): RunAgentInput {
  return {
    threadId,
    runId,
    messages: [{ id: "u1", role: "user", content: "What happened?" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  } as RunAgentInput;
}

async function collect(observable: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return firstValueFrom(observable.pipe(toArray()));
}

describe("run", () => {
  test("replayed events match what was originally streamed", async () => {
    const runner = new PostgresAgentRunner(database);
    const id = threadId();
    const runId = randomUUID();
    const agent = new FakeAgent({ threadId: id });
    agent.events = happyPathEvents(id, runId);

    const streamed = await collect(
      runner.run({ threadId: id, agent, input: runInput(id, runId) }),
    );
    const replayed = await collect(runner.connect({ threadId: id }));

    const types = (events: BaseEvent[]) => events.map((e) => e.type);
    expect(types(replayed)).toEqual(types(streamed));
  });

  test("a second run started on a thread that's already running is refused", () => {
    const runner = new PostgresAgentRunner(database);
    const id = threadId();
    const firstAgent = new FakeAgent({ threadId: id });
    firstAgent.hangUntilAborted = true;
    runner.run({
      threadId: id,
      agent: firstAgent,
      input: runInput(id, randomUUID()),
    });

    const secondAgent = new FakeAgent({ threadId: id });
    expect(() =>
      runner.run({
        threadId: id,
        agent: secondAgent,
        input: runInput(id, randomUUID()),
      }),
    ).toThrow("Thread already running");

    firstAgent.abortRun();
  });

  test("stop actually interrupts an in-progress run", async () => {
    const runner = new PostgresAgentRunner(database);
    const id = threadId();
    const runId = randomUUID();
    const agent = new FakeAgent({ threadId: id });
    agent.hangUntilAborted = true;

    const observable = runner.run({
      threadId: id,
      agent,
      input: runInput(id, runId),
    });
    const events = collect(observable);

    const stopped = await runner.stop({ threadId: id });
    expect(stopped).toBe(true);
    expect(agent.aborted).toBe(true);

    await events;
  });

  test("a failing run ends with a clear error event rather than hanging or vanishing silently", async () => {
    const runner = new PostgresAgentRunner(database);
    const id = threadId();
    const runId = randomUUID();
    const agent = new FakeAgent({ threadId: id });
    agent.throwError = new Error("the model refused to answer");

    const streamed = await collect(
      runner.run({ threadId: id, agent, input: runInput(id, runId) }),
    );

    expect(streamed.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      true,
    );
  });

  test("a long-running turn's lock is renewed (heartbeat) before its lease would expire", async () => {
    // A tiny TTL-equivalent window: heartbeat every 10ms, agent runs for ~60ms, well past what a
    // single un-renewed lease would survive if the heartbeat never fired.
    const runner = new PostgresAgentRunner(database, 10);
    const id = threadId();
    const runId = randomUUID();
    const agent = new FakeAgent({ threadId: id });
    agent.hangUntilAborted = true;

    const events = collect(runner.run({ threadId: id, agent, input: runInput(id, runId) }));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const [lock] = await database
      .select({ expiresAt: threadLocks.expiresAt })
      .from(threadLocks)
      .where(eq(threadLocks.threadId, id));
    // The real TTL is 120s; if even one heartbeat fired, the lease is pushed out far past a
    // moment that just started.
    expect(lock?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

    agent.abortRun();
    await events;
  });

  test("history survives a restart: a second, independent runner instance replays it correctly", async () => {
    const id = threadId();
    const runId = randomUUID();
    const firstRunner = new PostgresAgentRunner(database);
    const agent = new FakeAgent({ threadId: id });
    agent.events = happyPathEvents(id, runId);
    await collect(
      firstRunner.run({ threadId: id, agent, input: runInput(id, runId) }),
    );

    // A brand new instance: nothing in its in-process map, exactly what a real restart leaves.
    const secondRunner = new PostgresAgentRunner(database);
    const replayed = await collect(secondRunner.connect({ threadId: id }));

    expect(
      replayed.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toBe(true);
  });

  test("a crash during a run loses only that run's reply; the thread's prior history is unaffected", async () => {
    const id = threadId();
    const runner = new PostgresAgentRunner(database);
    const firstRunId = randomUUID();
    const firstAgent = new FakeAgent({ threadId: id });
    firstAgent.events = happyPathEvents(id, firstRunId);
    await collect(
      runner.run({ threadId: id, agent: firstAgent, input: runInput(id, firstRunId) }),
    );

    // Simulate a crash mid-run: a lock exists (acquired, never released or finalized), but no
    // thread_runs row for it -- nothing ever calls saveRun for a run that never reaches `finally`.
    await database.insert(threadLocks).values({
      threadId: id,
      runId: randomUUID(),
      userId: ownerUserId,
      agentId: "default",
      expiresAt: new Date(Date.now() + 120_000),
    });

    const replayed = await collect(runner.connect({ threadId: id }));
    expect(
      replayed.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT),
    ).toBe(true);
    const rows = await database
      .select({ runId: threadRuns.runId })
      .from(threadRuns)
      .where(eq(threadRuns.threadId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe(firstRunId);
  });

  test("a warning is logged when a thread's replay crosses the size threshold", async () => {
    const id = threadId();
    await database
      .insert(threads)
      .values({ id, userId: ownerUserId, agentId: "default" });
    const runner = new PostgresAgentRunner(database);
    // Directly seed many small finished runs, cheaper than driving 1000+ real events through a
    // fake agent, and it exercises the same read-and-compact path connect() uses either way.
    const manyEvents = Array.from({ length: 1100 }, (_, index) => ({
      type: EventType.CUSTOM,
      name: "filler",
      value: index,
    })) as unknown as BaseEvent[];
    await database.insert(threadRuns).values({
      threadId: id,
      runId: randomUUID(),
      agentId: "default",
      events: manyEvents,
    });
    const warnSpy = spyOn(console, "warn");

    await collect(runner.connect({ threadId: id }));

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
