import type { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { compactEvents, EventType } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
} from "@copilotkit/runtime/v2";
import { eq } from "drizzle-orm";
import { type Observable, ReplaySubject } from "rxjs";
import { DEV_ACTOR } from "./auth/dev-actor";
import type { Database } from "./db/client";
import { threadRuns } from "./db/schema";
import {
  createPostgresThreadBackend,
  THREAD_LOCK_TTL_SECONDS,
} from "./postgres-thread-backend";

/**
 * Renew the lock this far into its TTL, so a run that legitimately takes longer than the lease
 * never loses it to a takeover. A third of the TTL leaves two more chances before expiry if one
 * renewal is ever slow or dropped.
 */
const LOCK_HEARTBEAT_MS = (THREAD_LOCK_TTL_SECONDS / 3) * 1000;

/**
 * Warn, rather than silently get slower, once a single thread's replay crosses this many events.
 * No cap is enforced (docs/brooklyn/DECISIONS.md #25) -- this is only the signal that a real need
 * for pagination has arrived.
 */
const LARGE_REPLAY_EVENT_WARNING = 1000;

/**
 * One in-process run this runner is currently driving: enough to stream its live events to a late
 * subscriber and to abort it on `stop`. Durability is Postgres's job (see `saveRun` below) -- this
 * map exists only for the current process's own fast, synchronous bookkeeping, the same role
 * `InMemoryAgentRunner`'s own store plays, matching the Plan's template.
 */
type ActiveRun = {
  runId: string;
  agent: AbstractAgent;
  subject: ReplaySubject<BaseEvent>;
};

/**
 * Where a conversation lives in postgres mode (docs/brooklyn/PLAN.md Phase 2): the runner
 * `CopilotRuntime` drives the main chat path through, replacing Phase 1's temporary
 * `InMemoryAgentRunner`. Never marks itself as supporting the SDK's local thread endpoints
 * (docs/brooklyn/SECURITY.md) -- `ɵsupportsLocalThreadEndpoints` is left unset.
 *
 * SINGLE-USER SIMPLIFICATION. `AgentRunnerRunRequest` carries no user id -- the non-Intelligence
 * runtime does not wire `identifyUser` through to here (SECURITY.md, verified in the SDK source
 * during Phase 1). Every thread is attributed to `DEV_ACTOR` (the same fixed single-user actor
 * `OPENBOT_SINGLE_USER` already uses for everything else), which is correct for as long as this
 * stays a one-person deployment. Revisit together with the rest of per-user isolation in Phase 8.
 */
export class PostgresAgentRunner extends AgentRunner {
  private readonly database: Database;
  private readonly threadBackend: ReturnType<typeof createPostgresThreadBackend>;
  private readonly active = new Map<string, ActiveRun>();
  /** Overridable only so a test can see a heartbeat fire without waiting out the real TTL. */
  private readonly lockHeartbeatMs: number;

  constructor(database: Database, lockHeartbeatMs: number = LOCK_HEARTBEAT_MS) {
    super();
    this.database = database;
    this.threadBackend = createPostgresThreadBackend(database);
    this.lockHeartbeatMs = lockHeartbeatMs;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    // Synchronous and in-process, so two calls on the same thread in the same tick are refused
    // immediately -- the fast path `InMemoryAgentRunner` also takes, before any async work starts.
    if (this.active.has(request.threadId)) {
      throw new Error("Thread already running");
    }
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const active: ActiveRun = {
      runId: request.input.runId,
      agent: request.agent,
      subject,
    };
    this.active.set(request.threadId, active);
    void this.runAgent(request, active);
    return subject.asObservable();
  }

  private async runAgent(
    request: AgentRunnerRunRequest,
    active: ActiveRun,
  ): Promise<void> {
    const { threadId, agent, input } = request;
    const { subject, runId } = active;
    const currentEvents: BaseEvent[] = [];
    let hasRunStarted = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const pushEvent = (event: BaseEvent) => {
      currentEvents.push(event);
      subject.next(event);
      if (event.type === EventType.RUN_STARTED) hasRunStarted = true;
    };

    // Mirrors IntelligenceAgentRunner.executeAgentRun's event rules exactly (read from the
    // installed SDK during Phase 2's design), so the two runners behave identically from the
    // outside: a guaranteed RUN_STARTED carrying persistedInputMessages, built once whether the
    // agent emits its own or not.
    const buildRunStartedEvent = (source?: BaseEvent): BaseEvent => {
      const persistedInputMessages = request.persistedInputMessages ?? input.messages;
      return {
        ...(source ?? { type: EventType.RUN_STARTED }),
        threadId,
        runId,
        input: {
          ...input,
          threadId,
          runId,
          ...(persistedInputMessages !== undefined
            ? { messages: persistedInputMessages }
            : {}),
        },
      } as BaseEvent;
    };

    const ensureRunStarted = () => {
      if (!hasRunStarted) {
        hasRunStarted = true;
        pushEvent(buildRunStartedEvent());
      }
    };

    try {
      await this.threadBackend.getOrCreateThread({
        threadId,
        userId: DEV_ACTOR.id,
        agentId: agent.agentId ?? "default",
      });
      const acquired = await this.threadBackend.acquire({
        threadId,
        runId,
        userId: DEV_ACTOR.id,
        agentId: agent.agentId ?? "default",
      });
      if (!acquired) {
        throw new Error("Thread already running");
      }
      heartbeat = setInterval(() => {
        this.threadBackend.renew({ threadId, runId }).catch((error) => {
          console.error(
            "[PostgresAgentRunner] failed to renew the thread lock",
            error,
          );
        });
      }, this.lockHeartbeatMs);

      agent.threadId = threadId;
      await agent.runAgent(input as RunAgentInput, {
        onEvent: ({ event }: { event: BaseEvent }) => {
          if (event.type === EventType.RUN_STARTED) {
            pushEvent(buildRunStartedEvent(event));
            return;
          }
          ensureRunStarted();
          pushEvent(event);
        },
      });
    } catch (error) {
      ensureRunStarted();
      if (!currentEvents.some((event) => event.type === EventType.RUN_ERROR)) {
        pushEvent({
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : String(error),
        } as BaseEvent);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      ensureRunStarted();
      const appended = finalizeRunEvents(currentEvents, {
        stopRequested: false,
        protocolVersion: input.protocolVersion,
      });
      for (const event of appended) pushEvent(event);

      await this.saveRun({
        threadId,
        runId,
        agentId: agent.agentId ?? "default",
        events: compactEvents(currentEvents),
        messages: Array.isArray(agent.messages) ? [...agent.messages] : [],
      });
      await this.threadBackend
        .release({ threadId, runId })
        .catch(() => {});

      this.active.delete(threadId);
      subject.complete();
    }
  }

  /**
   * The one place a run's events reach Postgres (docs/brooklyn/DECISIONS.md #24): called exactly
   * once, at the end of a run. A later move to incremental (mid-run) flushing is a change to this
   * one function, not a restructuring of `runAgent`.
   */
  private async saveRun(run: {
    threadId: string;
    runId: string;
    agentId: string;
    events: BaseEvent[];
    messages: AbstractAgent["messages"];
  }): Promise<void> {
    await this.database.insert(threadRuns).values({
      threadId: run.threadId,
      runId: run.runId,
      agentId: run.agentId,
      events: run.events,
      messages: run.messages as never,
    });
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connectionSubject = new ReplaySubject<BaseEvent>(Infinity);
    void this.replayAndFollow(request.threadId, connectionSubject);
    return connectionSubject.asObservable();
  }

  private async replayAndFollow(
    threadId: string,
    connectionSubject: ReplaySubject<BaseEvent>,
  ): Promise<void> {
    try {
      const runs = await this.database
        .select({ events: threadRuns.events })
        .from(threadRuns)
        .where(eq(threadRuns.threadId, threadId))
        .orderBy(threadRuns.createdAt);
      const allHistoricEvents = runs.flatMap((run) => run.events);
      if (allHistoricEvents.length > LARGE_REPLAY_EVENT_WARNING) {
        console.warn(
          `[PostgresAgentRunner] thread ${threadId} has ${allHistoricEvents.length} events to replay -- no cap is enforced (docs/brooklyn/DECISIONS.md #25), but this is worth watching.`,
        );
      }
      const compacted = compactEvents(allHistoricEvents);
      for (const event of compacted) connectionSubject.next(event);

      const active = this.active.get(threadId);
      if (active) {
        active.subject.subscribe({
          next: (event) => connectionSubject.next(event),
          complete: () => connectionSubject.complete(),
          error: (error) => connectionSubject.error(error),
        });
      } else {
        connectionSubject.complete();
      }
    } catch (error) {
      connectionSubject.error(error);
    }
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.active.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const active = this.active.get(request.threadId);
    if (!active) return Promise.resolve(false);
    if (request.runId !== undefined && active.runId !== request.runId) {
      return Promise.resolve(false);
    }
    try {
      active.agent.abortRun();
      return Promise.resolve(true);
    } catch (error) {
      console.error("[PostgresAgentRunner] failed to abort agent run", error);
      return Promise.resolve(false);
    }
  }
}
