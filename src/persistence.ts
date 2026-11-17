import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";

export type Run = { key: string; prompt: string };
export type Outcome = { status: "completed" | "aborted" | "failed" | "detached" };

export interface PiRunDriver {
  outcome(run: Run): Outcome | undefined;
  isLive(key: string): boolean;
  resume(run: Run): void;
  wait(key: string, signal: AbortSignal): Promise<Outcome>;
  report(error: unknown): void;
}

/** Durable owns the pending-run receipt; Pi owns all reasoning, tools and session history. */
export async function openPersistence(directory: string, driver: PiRunDriver) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  const release = await lockfile.lock(directory, {
    stale: 10_000,
    update: 2_000,
    retries: { retries: 12, factor: 1, minTimeout: 1_000, maxTimeout: 1_000 },
    onCompromised: (error) => {
      driver.report(error);
      void harness?.close(context).catch(driver.report);
    },
  });
  try {
    const runTask = defineTask<Run, { phase: "run" }, Outcome>({
      name: "pi-harness.run",
      version: 1,
      initial: () => ({ phase: "run" }),
      phases: {
        run: async (task, runtime, taskContext) => {
          let outcome = driver.outcome(task.input);
          if (!outcome) {
            // Register before waking Pi: even a synchronous completion must not get lost.
            const waiting = driver.wait(task.input.key, runtime.signal);
            // If Pi itself throws before the await, cancellation still owns this pending wait.
            void waiting.catch(() => {});
            if (!driver.isLive(task.input.key)) driver.resume(task.input);
            outcome = await waiting;
          }
          await runtime.commit(() => ({
            status: "terminal",
            outcome: outcome.status === "aborted" || outcome.status === "detached"
              ? { status: "aborted" }
              : { status: "completed", result: outcome },
          }), taskContext);
        },
      },
      abort: (_task, runtime, taskContext) => runtime.commit(() => ({
        status: "terminal", outcome: { status: "aborted" },
      }), taskContext),
    });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "pi-harness", tasks: [runTask] }));
    // No provider is registered or called here. The *normal Pi agent* performs inference.
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
      models: createModels(), registry, onReport: ({ error }) => driver.report(error),
    }, context);
    const root = await harness.root(context);
    const opened = harness;
    let closed = false;
    return {
      start: (run: Run) => root.commit(async (tx) => {
        let cursor;
        do {
          const page = await tx.scanTasks({ conversationId: root.id, kind: "pi-harness.run" }, 100, cursor);
          const existing = page.items.find((task) => (task.input as Run).key === run.key);
          if (existing) return existing.id;
          cursor = page.next;
        } while (cursor !== undefined);
        return tx.createTask(runTask, run, { ownership: { kind: "conversation" } });
      }, context),
      resume: () => opened.resume(),
      idle: () => opened.waitForIdle(context),
      inspect: () => opened.inspect(context),
      wait: (id: Parameters<typeof opened.waitForTask>[0]) => opened.waitForTask(id, context),
      async close() {
        if (closed) return;
        closed = true;
        try { await opened.close(context); } finally { await release(); }
      },
    };
  } catch (error) {
    try { await harness?.close(context); } finally { await release(); }
    throw error;
  }
}

export type Persistence = Awaited<ReturnType<typeof openPersistence>>;
