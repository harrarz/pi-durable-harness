// Opt-in real Codex test. All task files/sessions stay in a private temporary directory.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { temporaryProfile } from "./temporary-profile.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const settings = SettingsManager.create(root);
const provider = settings.getDefaultProvider();
const model = settings.getDefaultModel();
const runtime = await ModelRuntime.create();
assert.equal(provider, "openai-codex");
assert.ok(model && runtime.isUsingSubscription(provider), "Existing Codex subscription required.");
const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-durable-live-recovery-")));
const sessions = join(directory, "sessions");
const receipt = join(directory, "receipt.txt");
const pidFile = join(directory, "tool.pid");
const gate = join(directory, "release");
const final = join(directory, "final.txt");
const activeWorker = process.env.PI_DURABLE_TEMP_PROFILE === "1";
const delegate = activeWorker || process.env.PI_DURABLE_LIVE_DELEGATE === "1";
const workerDir = join(directory, "a");
const workerReceipt = join(workerDir, "receipt.txt");
const workerGate = join(workerDir, "release");
const workerPidFile = join(workerDir, "tool.pid");
const resumeCommand = process.env.PI_DURABLE_RESUME_COMMAND ?? "/durable-resume";
const inputs = { a: Array.from({ length: 20 }, (_, i) => i + 1), b: Array.from({ length: 20 }, (_, i) => i + 21) };
if (delegate) {
  for (const [name, values] of Object.entries(inputs)) {
    await mkdir(join(directory, name));
    await writeFile(join(directory, name, "input.json"), JSON.stringify(values));
  }
}
const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const children = new Set();
let toolPid, temporary, workerRecovery;
let stopping = false, cleanupPromise, overallTimer;
const startedAt = Date.now();
const progress = (message) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${message}`);
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const parse = (stream) => stream.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const runCommand = promisify(execFile);
async function killVerified(pid, identity, birth) {
  assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  if (birth) {
    // Pi sets process.title, hiding its argv. Verify the supervisor's birth identity and our unique cwd instead.
    let actualBirth, cwd;
    if (process.platform === "linux") {
      const snapshot = await readFile(`/proc/${pid}/stat`, "utf8");
      actualBirth = `linux:${snapshot.slice(snapshot.lastIndexOf(")") + 1).trim().split(/\s+/)[19]}`;
      cwd = await realpath(`/proc/${pid}/cwd`);
    } else {
      actualBirth = `${process.platform}:${(await runCommand("ps", ["-p", String(pid), "-o", "lstart="])).stdout.trim()}`;
      const listing = (await runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])).stdout;
      cwd = listing.split("\n").find((line) => line.startsWith("n"))?.slice(1);
    }
    assert.equal(actualBirth, birth, "Worker PID has changed identity; refusing to signal it.");
    assert.equal(cwd, identity, "Worker PID is not in our test workspace.");
  } else {
    let command;
    try { command = (await runCommand("ps", ["ww", "-p", String(pid), "-o", "command="])).stdout; }
    catch (error) { if (error.code === 1) return; throw error; }
    assert.ok(command.includes(identity), "PID no longer matches the test-owned process; refusing to signal it.");
  }
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
function launch(extra, label, worker = false) {
  assert.ok(!stopping, "Test is stopping; no further processes may start.");
  const supervisor = process.env.PI_SUPERVISOR_EXTENSION;
  const child = spawn(process.execPath, [cli, ...(worker || supervisor ? ["--no-extensions"] : []),
    ...(!worker && supervisor ? ["-e", supervisor] : []), "-e", join(root, "src", "index.ts"),
    "--no-skills", "--no-prompt-templates", "--provider", provider,
    "--model", model, "--thinking", "minimal", "--mode", "json", "--session-dir", sessions, ...extra], {
    cwd: worker ? workerDir : directory, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit").then(async ([code, signal]) => {
    children.delete(child);
    await writeFile(join(directory, `${label}.jsonl`), stdout);
    await writeFile(join(directory, `${label}.stderr`), stderr);
    return { code, signal, stdout, stderr };
  });
  return { child, exited, output: () => stdout };
}

async function recoverWorker(parent) {
  const events = parse(parent.output());
  const start = events.find((event) => event.type === "tool_execution_start" && event.toolName === "agent_start" && event.args.cwd === workerDir);
  assert.ok(start, "Worker A was not launched through the existing agent_start tool.");
  const end = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId);
  assert.ok(end, "No worker launch receipt.");
  const { id } = JSON.parse(end.result.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
  const records = join(getAgentDir(), "agent-supervisor/runtime/runs");
  let record;
  for (const folder of await readdir(records, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const file = join(records, folder.name, `${id}.json`);
    if (await exists(file)) { record = JSON.parse(await readFile(file, "utf8")); break; }
  }
  assert.equal(record?.cwd, workerDir);
  assert.equal(record.profile, temporary.name);
  assert.equal(record.model, `${provider}/${model}`);
  const file = record.control.sessionPath;
  assert.ok(await exists(`${file}.durable/session.sqlite`), "Worker must actually have Durable enabled.");
  const original = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const checkpointContents = await readFile(join(workerDir, "progress.json"), "utf8");
  const modified = (await stat(join(workerDir, "progress.json"))).mtimeMs;
  progress(`Interrupting active worker ${id.slice(0, 8)} after its checkpoint`);
  await killVerified(record.processPid, workerDir, record.processStartIdentity);
  await killVerified(Number((await readFile(workerPidFile, "utf8")).trim()), workerDir);
  await writeFile(workerGate, "released\n");
  progress("Reopening the worker's saved Pi conversation");
  const resumed = launch(["--session", file, "/durable-resume"], "worker-resumed", true);
  const timer = setTimeout(() => resumed.child.kill("SIGTERM"), 180_000);
  const result = await resumed.exited;
  clearTimeout(timer);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(workerReceipt, "utf8"), "once\n");
  assert.equal(await readFile(join(workerDir, "progress.json"), "utf8"), checkpointContents);
  assert.equal((await stat(join(workerDir, "progress.json"))).mtimeMs, modified, "Completed checkpoint must not be rewritten.");
  const restored = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(restored[0].id, original[0].id, "Worker must reopen its original Pi conversation.");
  assert.equal(restored.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
  assert.equal(restored.filter((entry) => entry.customType === "pi-durable-harness.run" && entry.data.status === "started").length, 1);
  assert.ok(await exists(join(workerDir, "result.json")));
  progress("Worker recovery verified; waiting for manager checkpoint");
  return { originalRunId: id, sameConversation: true, receipt: "once\n", exitCode: result.code, checkpointUnchanged: true };
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  stopping = true;
  cleanupPromise = (async () => {
    // Restore trusted configuration first, even if a process takes time to stop.
    await temporary?.restore();
    for (const child of [...children]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
      await exited;
      clearTimeout(timer);
    }
    if (toolPid) { try { await killVerified(toolPid, directory); } catch {} }
  })();
  return cleanupPromise;
}
const interrupt = () => {
  progress("Stopping live test and restoring configuration");
  void cleanup().then(() => process.exit(1), (error) => { console.error(error); process.exit(1); });
};

try {
  if (activeWorker) {
    temporary = await temporaryProfile(getAgentDir(), {
      executable: process.execPath,
      args: [cli, "--no-extensions", "-e", join(root, "src/index.ts"), "--no-skills", "--no-prompt-templates", "--thinking", "minimal", "--mode", "rpc", "--session", "{session}", "{modelArgs}"],
      modelArgs: ["--model", "{model}"], modelFormat: "qualified", parentProviders: ["openai-codex"],
      taskTransport: "pi-rpc", outputProtocol: "pi-jsonl",
    }, directory);
    console.log(`Temporary worker profile: ${temporary.name} (will be removed after this test)`);
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  overallTimer = setTimeout(interrupt, 210_000);
  progress(`Live test started; artifacts: ${directory}`);
  const profile = temporary?.name ?? "pi";
  const task = `This is an explicitly authorized local crash-recovery test, not a research task. Use bash to run this one command: `
    + `printf '%s\\n' "$$" > '${pidFile}'; printf 'once\\n' >> '${receipt}'; `
    + `while [ ! -f '${gate}' ]; do sleep 1; done; printf 'complete\\n' > '${final}'. `
    + `Then answer DONE. Do not start agents or use the network. On recovery, inspect the files first: `
    + `if receipt.txt exists, NEVER append to it again; if final.txt is missing and release exists, only write final.txt with complete and a newline. `
    + `The command is deliberately waiting for the test controller; do not create release yourself.`;
  const delegation = `Before the waiting command, you are explicitly instructed to launch exactly TWO independent agents `
    + `using agent_start with profile ${profile} and isolation shared. Their cwd values must be '${join(directory, "a")}' `
    + `and '${join(directory, "b")}', respectively. Give each this task: read its input.json, compute the sum of squares `
    + `using code, write result.json containing {"sumSquares":number}, and respond with the result. Do not use the network `
    + `or delegate further. `
    + (activeWorker ? `Additional instructions ONLY for A: before writing result.json, write progress.json with the computed `
      + `sumSquares, then use bash to run: printf '%s\\n' "$$" > '${workerPidFile}'; printf 'once\\n' >> '${workerReceipt}'; `
      + `while [ ! -f '${workerGate}' ]; do sleep 1; done. The test controller will intentionally kill and restart `
      + `that worker in the SAME saved Pi session. A must NEVER recreate progress.json or append receipt.txt after recovery; `
      + `read and verify its existing progress, then write result.json. A must NOT create release itself. `
      + `The parent must NOT launch replacements: A's old process record may say interrupted, while its original conversation `
      + `is being resumed by the controller. For A, use a bash file-existence wait for result.json instead of polling agent_get. `
      + `For B wait for agent_get to report exited with code 0. `
      : `Poll agent_get until BOTH processes are completed. `)
    + `Read both result.json files yourself, `
    + `and write '${join(directory, "summary.json")}' containing {"total":number} with their combined sum. `
    + `Only then run the waiting command below. On recovery, retain and verify completed worker artifacts; NEVER launch `
    + `replacement agents if their results already exist.\n\n`;
  const first = launch([delegate ? delegation + task.replace("Do not start agents or use the network.", "Do not launch any more agents or use the network.") : task], "initial");
  const deadline = Date.now() + 180_000;
  while (!(await exists(receipt)) || !(await exists(pidFile))) {
    assert.ok(children.has(first.child), "Pi exited before reaching the interruption point.");
    assert.ok(Date.now() < deadline, `Timed out before interruption; inspect ${directory}`);
    if (activeWorker && !workerRecovery && await exists(workerReceipt) && await exists(workerPidFile)) {
      workerRecovery = await recoverWorker(first);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  toolPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(toolPid) && toolPid > 1 && toolPid !== process.pid);
  progress("Manager checkpoint reached; interrupting manager");
  first.child.kill("SIGKILL");
  const firstExit = await first.exited;
  assert.equal(firstExit.signal, "SIGKILL");
  // This PID was reported by our own still-waiting test shell. Do not let an orphan finish the test for us.
  await killVerified(toolPid, directory);
  toolPid = undefined;
  await writeFile(gate, "released\n");
  assert.equal(await exists(final), false, "The initial shell must not finish the task after its host was killed.");
  const files = (await readdir(sessions)).filter((file) => file.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const extra = ["--session", join(sessions, files[0])];
  if (resumeCommand) extra.push(resumeCommand);
  progress("Reopening the manager's saved Pi conversation");
  const second = launch(extra, "resumed");
  const timer = setTimeout(() => second.child.kill("SIGTERM"), 180_000);
  const result = await second.exited;
  clearTimeout(timer);
  const completed = await exists(final);
  const summary = {
    directory, provider, model, initialSignal: firstExit.signal, resumeExit: result.code,
    completed, receipt: await readFile(receipt, "utf8"),
    final: completed ? await readFile(final, "utf8") : null,
    resumeCommand: resumeCommand || null,
  };
  if (delegate) {
    const starts = [...parse(firstExit.stdout), ...parse(result.stdout)].filter((event) => event.type === "tool_execution_start" && event.toolName === "agent_start");
    assert.equal(starts.length, 2, "Completed agents must not be launched a second time after recovery.");
    assert.ok(starts.every((event) => event.args.profile === profile));
    for (const [name, values] of Object.entries(inputs)) {
      const output = JSON.parse(await readFile(join(directory, name, "result.json"), "utf8"));
      assert.equal(output.sumSquares, values.reduce((sum, value) => sum + value * value, 0));
    }
    const output = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
    const expected = Object.values(inputs).flat().reduce((sum, value) => sum + value * value, 0);
    assert.equal(output.total, expected);
    Object.assign(summary, { agentStarts: starts.length, verifiedTotal: output.total });
  }
  if (activeWorker) {
    assert.ok(workerRecovery, "The active-worker interruption must actually have happened.");
    Object.assign(summary, { workerRecovery });
    await temporary.restore();
    Object.assign(summary, { temporaryProfileRemoved: true });
  }
  await writeFile(join(directory, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(completed, true, "Headless Pi exited without completing the pending task.");
  assert.equal(summary.receipt, "once\n", "An interrupted side effect was repeated.");
  assert.equal(summary.final, "complete\n");
} finally {
  clearTimeout(overallTimer);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  await cleanup();
}
