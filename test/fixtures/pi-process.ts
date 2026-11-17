import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { MARKER } from "../../src/index.ts";
import { closePi, openPi, until } from "../helpers.ts";

const [directory, mode, sessionFile] = process.argv.slice(2);
const keepAlive = setInterval(() => {}, 1_000);
let file: string;
const ready = () => process.send?.({ type: "ready", file });
const hang = () => new Promise<never>(() => {});
let responses: FauxResponseStep[];
if (mode === "resume") responses = [fauxAssistantMessage("Recovered from saved Pi session.")];
else if (mode === "first-request") responses = [() => { ready(); return hang(); }];
else if (mode === "after-answer") responses = [fauxAssistantMessage("Already finished before crash.")];
else if (mode === "unsafe-tool") responses = [
  fauxAssistantMessage(fauxToolCall("fixture_wait", {}), { stopReason: "toolUse" }),
];
else responses = [
  fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'once\\n' >> receipt.txt" }), { stopReason: "toolUse" }),
  () => { ready(); return hang(); },
];
const opened = await openPi(directory, responses, sessionFile, [(pi) => {
  pi.registerTool({
    name: "fixture_wait", label: "Unsafe test operation", description: "Test-only interrupted side effect",
    parameters: Type.Object({}),
    async execute() {
      await appendFile(join(directory, "receipt.txt"), "once\n");
      ready();
      return hang();
    },
  });
  if (mode === "after-answer") pi.on("agent_before_settle", async () => { ready(); return hang(); });
}]);
file = opened.manager.getSessionFile()!;

if (mode === "resume") {
  await until(() => opened.session.getLastAssistantText() === "Recovered from saved Pi session.", 25_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  let receipt = "";
  try { receipt = await readFile(join(directory, "receipt.txt"), "utf8"); } catch {}
  const entries = opened.manager.getEntries();
  process.send?.({
    type: "result", text: opened.session.getLastAssistantText(), receipt,
    calls: opened.faux.state.callCount, errors: opened.errors,
    users: entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
    starts: entries.filter((entry) => entry.type === "custom" && entry.customType === MARKER
      && (entry.data as { status: string }).status === "started").length,
  });
  await closePi(opened.session);
  clearInterval(keepAlive);
  process.disconnect?.();
} else {
  await opened.session.prompt("Perform the assigned task; preserve completed work.");
}
