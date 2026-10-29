import { and, desc, eq, lt, or } from "drizzle-orm";
import type { ThreadBackend, ThreadLock } from "@openbot/toolkit/ports";
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
          /*
           * Take over a lease that has already expired -- an unexpired one held by a DIFFERENT run
           * id is left alone, which is what makes a second concurrent run refused rather than
           * silently superseded. The other half, matching this exact run id, is a RE-acquire by the
           * same holder, not a second run: `runId` is minted once per logical run and never reused,
           * so two acquires carrying it are always the same run asking twice, never two different
           * ones racing. This is what lets an external locker (`createTurnRunner`'s `takeLease` for a
           * headless turn, or hand-off delivery's own lock) and `PostgresAgentRunner`'s internal
           * acquire agree on ONE shared instance without one of them losing to the other
           * (Phase 3: docs/brooklyn/DECISIONS.md #28).
           */
          setWhere: or(
            lt(threadLocks.expiresAt, new Date()),
            eq(threadLocks.runId, runId),
          ),
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

/**
 * The conversation's run lock for postgres mode, as hand-off delivery needs it: creates the thread
 * if it is new, then takes the lock, telling `onRunBusy` when a run starts and ends.
 *
 * One layer down from `createIntelligenceThreadLock` (`toolkit/src/copilotkit/thread-lock.ts`), and
 * simpler: `ThreadBackend.acquire` already answers a conflict with `null` directly, so there is no
 * exception-shaped 409 to translate, and postgres mode has no Learning container to resolve --
 * `learning` is always `undefined` there (Phase 1).
 */
export function createPostgresThreadLock(options: {
  backend: ThreadBackend;
  onRunBusy?: (input: { threadId: string; busy: boolean }) => void;
}): ThreadLock {
  const { backend, onRunBusy } = options;
  return {
    acquire: async (input) => {
      await backend.getOrCreateThread(input);
      const held = await backend.acquire(input);
      // A run started on this thread. Side effect only, never awaited: a channel showing it is
      // working is worth nothing next to the lock the run depends on.
      if (held) {
        try {
          onRunBusy?.({ threadId: input.threadId, busy: true });
        } catch {}
      }
      return held;
    },
    renew: (input) => backend.renew(input),
    release: async (input) => {
      // The run on this thread is over. Told before the release lands, same as the Intelligence
      // version, since the one thing the hand-off has already produced -- its reply -- matters more
      // than this notification, which is best-effort either way.
      try {
        onRunBusy?.({ threadId: input.threadId, busy: false });
      } catch {}
      await backend.release(input);
    },
  };
}
