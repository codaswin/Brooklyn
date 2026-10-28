import type { BaseEvent } from "@ag-ui/client";
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ThreadBackendMessage } from "@openbot/toolkit/ports";
import { users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A conversation in postgres mode (Phase 2: docs/brooklyn/PLAN.md). `agentId` names no row of its
 * own -- a built-in Bot such as `general-assistant` is never a row in `agents`, so this stays a
 * plain column rather than a foreign key.
 */
export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull(),
  name: text("name"),
  archived: boolean("archived").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One finished run on a thread. `events` is the run's own compacted AG-UI events (what `connect`
 * replays); `messages` is a snapshot of the thread's messages as of this run, matching the SDK's
 * own in-memory runner, which keeps a snapshot only on the latest run and clears older ones to `[]`
 * to avoid storing the same growing array on every row.
 */
export const threadRuns = pgTable(
  "thread_runs",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    parentRunId: text("parent_run_id"),
    agentId: text("agent_id").notNull(),
    events: jsonb("events").$type<BaseEvent[]>().notNull(),
    messages: jsonb("messages")
      .$type<ThreadBackendMessage[]>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.threadId, table.runId] }),
    index("thread_runs_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
  ],
);

/**
 * One run at a time per thread (docs/brooklyn/SECURITY.md, docs/brooklyn/PLAN.md Phase 2).
 * `expiresAt` is the lease: an `acquire` past it may take the row over, which is how a crashed run's
 * lock stops blocking a retry without anybody cleaning it up by hand.
 */
export const threadLocks = pgTable("thread_locks", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
