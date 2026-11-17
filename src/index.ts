import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { openPersistence, type Outcome, type Persistence, type Run } from "./persistence.ts";

export const MARKER = "pi-durable-harness.run";
const RECOVERY = "pi-durable-harness.resume";
type Marker = { key?: string; status?: string; prompt?: string };
const terminal = (status: string | undefined): status is Outcome["status"] =>
  status === "completed" || status === "aborted" || status === "failed" || status === "detached";
const text = (content: string | readonly { type: string; text?: string }[]) => typeof content === "string"
  ? content : content.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n");

/** A final answer is not a settled run: other Pi extensions can still continue it. */
export function runOutcome(entries: readonly SessionEntry[], key: string): Outcome | undefined {
  let found = false;
  let outcome: Outcome | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MARKER) continue;
    const data = entry.data as Marker;
    if (data?.key !== key) continue;
    found = true;
    outcome = terminal(data.status) ? { status: data.status } : undefined;
  }
  return found ? outcome : { status: "detached" };
}

/** A normal Pi extension: no replacement agent, authentication, tools, or terminal UI. */
export default function durablePi(pi: ExtensionAPI) {
  let ctx: ExtensionContext;
  let persistence: Persistence | undefined;
  let pendingInput: Run | undefined;
  let recoveryQueued = false;
  let closing = false;
  let fatal: unknown;
  const live = new Set<string>();
  const waiters = new Map<string, { resolve: (outcome: Outcome) => void }>();
  const report = (error: unknown) => {
    fatal = error;
    const message = `Pi Durable stopped: ${error instanceof Error ? error.message : String(error)}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(`${message}\n`);
    ctx.abort(); // Do not continue silently without the requested persistence.
  };
  const record = async (run: Run, running: boolean) => {
    pi.appendEntry(MARKER, { ...run, status: "started" });
    if (running) live.add(run.key);
    await persistence!.start(run);
  };

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      ctx.ui.notify("Pi Durable requires a persistent Pi session; disabled for --no-session.", "warning");
      return;
    }
    try {
      persistence = await openPersistence(`${sessionFile}.durable`, {
        outcome: (run) => runOutcome(ctx.sessionManager.getBranch(), run.key),
        isLive: (key) => live.has(key),
        wait: (key, signal) => new Promise((resolve, reject) => {
          const cleanup = () => { waiters.delete(key); signal.removeEventListener("abort", onAbort); };
          const onAbort = () => { cleanup(); reject(signal.reason ?? new Error("Pi host closed")); };
          waiters.set(key, { resolve: (outcome) => { cleanup(); resolve(outcome); } });
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
        resume: (run) => {
          live.add(run.key);
          pi.appendEntry(MARKER, { key: run.key, status: "resuming" });
          if (recoveryQueued) return;
          recoveryQueued = true;
          setImmediate(() => {
            if (closing || fatal) return;
            pi.sendMessage({
              customType: RECOVERY,
              content: "The previous Pi process stopped before this run settled. Continue from this session's "
                + "history and existing files. Inspect current artifacts and subagents first; do not blindly repeat "
                + "commands or completed work. If the last answer already finished the task, verify that and stop."
                + "\n\nOriginal request:\n" + run.prompt,
              display: true,
            }, { triggerTurn: true, deliverAs: "followUp" });
          });
        },
        report,
      });
      // Repair a crash between Pi's journal and Durable's receipt. start() is idempotent by key.
      const branch = ctx.sessionManager.getBranch();
      const pending = new Map<string, Run>();
      for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== MARKER) continue;
        const data = entry.data as Marker;
        if (!data?.key) continue;
        if (terminal(data.status)) pending.delete(data.key);
        else if (data.status === "started" && typeof data.prompt === "string") pending.set(data.key, { key: data.key, prompt: data.prompt });
      }
      for (const run of pending.values()) await persistence.start(run);
      if (pending.size === 0) {
        const projection = ctx.sessionManager.buildSessionProjection();
        const last = projection.entries.findLast((entry) => entry.messages.some((message) => message.role !== "system"));
        const message = last?.messages.findLast((item) => item.role !== "system");
        const after = last ? branch.slice(branch.findIndex((entry) => entry.id === last.sourceEntry.id) + 1) : [];
        const ended = after.some((entry) => entry.type === "custom" && entry.customType === MARKER && terminal((entry.data as Marker)?.status));
        const unanswered = message?.role === "user" || message?.role === "toolResult"
          || (message?.role === "assistant" && message.content.some((part) => part.type === "toolCall"));
        if (unanswered && !ended) {
          const user = projection.messages.findLast((item) => item.role === "user");
          await record({ key: randomUUID(), prompt: user ? text(user.content) : "Continue the unfinished task in this session." }, false);
        }
      }
      if (ctx.mode !== "json" && ctx.mode !== "print") persistence.resume();
    } catch (error) { report(error); }
  });

  pi.registerCommand("durable-resume", {
    description: "Resume pending Pi work and wait for it (including in headless print/JSON mode)",
    async handler(_args, context) {
      ctx = context;
      if (fatal) throw fatal;
      if (!persistence) throw new Error("Pi Durable requires a persistent Pi session.");
      persistence.resume();
      await persistence.idle();
      await context.waitForIdle();
    },
  });

  pi.on("input", () => fatal ? { action: "handled" } : undefined);

  pi.on("before_agent_start", (event, context) => {
    ctx = context;
    if (fatal) { context.abort(); return; }
    if (closing || !persistence || (event.messageType === "custom" && event.message.customType === RECOVERY)) return;
    pendingInput = { key: randomUUID(), prompt: event.messageType === "user" ? event.prompt : text(event.message.content) };
  });

  const checkpoint = async (context: ExtensionContext) => {
    ctx = context;
    const file = ctx.sessionManager.getSessionFile();
    if (!pendingInput || !persistence || closing || fatal || !file || !existsSync(file)) return;
    const run = pendingInput;
    pendingInput = undefined;
    try {
      // Unlike message_end hooks, these boundaries see input already written by Pi.
      await record(run, true);
      persistence.resume();
    } catch (error) { report(error); }
  };
  pi.on("context", async (_event, context) => { await checkpoint(context); });
  pi.on("tool_call", async (_event, context) => { await checkpoint(context); });
  pi.on("turn_end", async (_event, context) => { await checkpoint(context); });

  pi.on("agent_settled", (event, context) => {
    if (closing || fatal) return;
    ctx = context;
    recoveryQueued = false;
    const last = ctx.sessionManager.buildSessionProjection().messages.findLast((message) => message.role === "assistant");
    const outcome: Outcome = event.aborted ? { status: "aborted" }
      : !last || last.stopReason === "error" ? { status: "failed" }
        : last.stopReason === "aborted" ? { status: "aborted" } : { status: "completed" };
    if (pendingInput) {
      pi.appendEntry(MARKER, { ...pendingInput, status: "started" });
      live.add(pendingInput.key);
      pendingInput = undefined;
    }
    for (const key of live) {
      pi.appendEntry(MARKER, { key, status: outcome.status });
      waiters.get(key)?.resolve(outcome);
    }
    live.clear();
  });

  pi.on("session_shutdown", async () => {
    if (closing) return;
    closing = true;
    for (const key of live) pi.appendEntry(MARKER, { key, status: "suspended" });
    await persistence?.close();
    persistence = undefined;
  });
}
