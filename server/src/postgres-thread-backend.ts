import { and, desc, eq, lt } from "drizzle-orm";
import type { ThreadBackend } from "@openbot/toolkit/ports";
import type { Database } from "./db/client";
import { threadLocks, threadRuns, threads } from "./db/schema";

/**
 * How long an acquired lock lasts before an expired lease may be taken over (docs/brooklyn/PLAN.md
 * Phase 2, matching the Intelligence platform's own documented lease length).
 */
export const THREAD_LOCK_TTL_SECONDS = 120;

/**
 * Where a conversation lives in postgres mode: the Postgres-backed `ThreadBackend`
 * `PostgresAgentRunner` is built on (Phase 2). No ThreadBackend existed before this -- see
 * docs/brooklyn/DECISIONS.md #24-25 for the persistence-timing and no-replay-cap decisions this
 * implements.
 */
export function createPostgresThreadBackend(database: Database): ThreadBackend {
  return {
    async getOrCreateThread({ threadId, userId, agentId }) {
      await database
        .insert(threads)
        .values({ id: threadId, userId, agentId })
        .onConflictDoNothing();
    },

    async getThread({ threadId, userId }) {
      const [row] = await database
        .select({
          id: threads.id,
          userId: threads.userId,
          agentId: threads.agentId,
        })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
        .limit(1);
      return row;
    },

    async getThreadMessages({ threadId, userId }) {
      const [thread] = await database
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
        .limit(1);
      // A thread nobody has run yet, or one that isn't this user's, reads as empty rather than
      // as a 500 -- the same choice IntelligenceKnowingANewThread already makes (copilot.ts).
      if (!thread) return { messages: [] };

      const [latestRun] = await database
        .select({ messages: threadRuns.messages })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, threadId))
        .orderBy(desc(threadRuns.createdAt))
        .limit(1);
      return { messages: latestRun?.messages ?? [] };
    },

    async acquire({ threadId, runId, userId, agentId }) {
      const expiresAt = new Date(Date.now() + THREAD_LOCK_TTL_SECONDS * 1000);
      const [row] = await database
        .insert(threadLocks)
        .values({ threadId, runId, userId, agentId, expiresAt })
        .onConflictDoUpdate({
          target: threadLocks.threadId,
          // Only take over a lease that has already expired -- an unexpired one is left alone,
          // which is what makes a second concurrent run refused rather than silently superseded.
          setWhere: lt(threadLocks.expiresAt, new Date()),
          set: { runId, userId, agentId, expiresAt },
        })
        .returning({ runId: threadLocks.runId });
      return row && row.runId === runId ? { runId } : null;
    },

    async renew({ threadId, runId }) {
      const [row] = await database
        .update(threadLocks)
        .set({
          expiresAt: new Date(Date.now() + THREAD_LOCK_TTL_SECONDS * 1000),
        })
        .where(
          and(eq(threadLocks.threadId, threadId), eq(threadLocks.runId, runId)),
        )
        .returning({ runId: threadLocks.runId });
      if (!row) {
        throw new Error(
          `Cannot renew the lock on thread ${threadId}: run ${runId} does not hold it.`,
        );
      }
    },

    async release({ threadId, runId }) {
      await database
        .delete(threadLocks)
        .where(
          and(eq(threadLocks.threadId, threadId), eq(threadLocks.runId, runId)),
        );
    },
  };
}
