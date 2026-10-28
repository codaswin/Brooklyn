import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { threadLocks, threads, users } from "../src/db/schema";
import { createPostgresThreadBackend } from "../src/postgres-thread-backend";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const backend = createPostgresThreadBackend(database);

const suite = randomUUID().slice(0, 8);
const userId = `thread_backend_user_${suite}`;
const agentId = "general-assistant";

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

function threadId() {
  return `thread_${randomUUID()}`;
}

describe("getOrCreateThread", () => {
  test("is idempotent: a second call for the same thread id does not error or duplicate", async () => {
    const id = threadId();

    await backend.getOrCreateThread({ threadId: id, userId, agentId });
    await backend.getOrCreateThread({ threadId: id, userId, agentId });

    const rows = await database
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, id));
    expect(rows).toHaveLength(1);
  });
});

describe("getThread", () => {
  test("returns nothing for a thread that doesn't exist", async () => {
    await expect(
      backend.getThread({ threadId: threadId(), userId }),
    ).resolves.toBeUndefined();
  });

  test("returns the thread once created", async () => {
    const id = threadId();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });

    await expect(backend.getThread({ threadId: id, userId })).resolves.toEqual(
      { id, userId, agentId },
    );
  });

  test("returns nothing for a thread that belongs to a different user", async () => {
    const id = threadId();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });

    await expect(
      backend.getThread({ threadId: id, userId: "somebody-else" }),
    ).resolves.toBeUndefined();
  });
});

describe("getThreadMessages", () => {
  test("returns no messages for a thread nobody has run yet", async () => {
    const id = threadId();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });

    await expect(backend.getThreadMessages({ threadId: id, userId })).resolves.toEqual(
      { messages: [] },
    );
  });

  test("returns no messages, rather than throwing, for a thread that doesn't exist", async () => {
    await expect(
      backend.getThreadMessages({ threadId: threadId(), userId }),
    ).resolves.toEqual({ messages: [] });
  });
});

describe("the lock", () => {
  test("acquiring with no existing lease succeeds", async () => {
    const id = threadId();
    const runId = randomUUID();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });

    await expect(
      backend.acquire({ threadId: id, runId, userId, agentId }),
    ).resolves.toEqual({ runId });
  });

  test("acquiring a thread whose lease is still live, held by a different run, returns nothing", async () => {
    const id = threadId();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });
    await backend.acquire({
      threadId: id,
      runId: randomUUID(),
      userId,
      agentId,
    });

    await expect(
      backend.acquire({
        threadId: id,
        runId: randomUUID(),
        userId,
        agentId,
      }),
    ).resolves.toBeNull();
  });

  test("acquiring a thread whose lease has expired succeeds, taking it over", async () => {
    const id = threadId();
    const staleRunId = randomUUID();
    const newRunId = randomUUID();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });
    await backend.acquire({ threadId: id, runId: staleRunId, userId, agentId });
    // Simulate the lease having expired, rather than waiting out the real TTL.
    await database
      .update(threadLocks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(threadLocks.threadId, id));

    await expect(
      backend.acquire({ threadId: id, runId: newRunId, userId, agentId }),
    ).resolves.toEqual({ runId: newRunId });
  });

  test("renewing with the correct run id extends the lease", async () => {
    const id = threadId();
    const runId = randomUUID();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });
    await backend.acquire({ threadId: id, runId, userId, agentId });
    await database
      .update(threadLocks)
      .set({ expiresAt: new Date(Date.now() + 1000) })
      .where(eq(threadLocks.threadId, id));

    await backend.renew({ threadId: id, runId });

    const [row] = await database
      .select({ expiresAt: threadLocks.expiresAt })
      .from(threadLocks)
      .where(eq(threadLocks.threadId, id));
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  test("renewing with the wrong run id fails", async () => {
    const id = threadId();
    const runId = randomUUID();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });
    await backend.acquire({ threadId: id, runId, userId, agentId });

    await expect(
      backend.renew({ threadId: id, runId: randomUUID() }),
    ).rejects.toThrow();
  });

  test("releasing early makes the thread immediately acquirable again", async () => {
    const id = threadId();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    await backend.getOrCreateThread({ threadId: id, userId, agentId });
    await backend.acquire({ threadId: id, runId: firstRunId, userId, agentId });

    await backend.release({ threadId: id, runId: firstRunId });

    await expect(
      backend.acquire({ threadId: id, runId: secondRunId, userId, agentId }),
    ).resolves.toEqual({ runId: secondRunId });
  });
});
