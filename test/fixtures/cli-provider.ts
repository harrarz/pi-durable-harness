// Test-only native Pi provider. No network or real credentials are used.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export default function fixture(pi: ExtensionAPI) {
  const phase = process.env.PI_DURABLE_TEST_PHASE;
  const faux = fauxProvider();
  let sessionFile: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const ready = () => process.send?.({ type: "ready", sessionFile });
  const hang = () => new Promise<never>(() => {});
  if (phase === "resume") faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "recovered.txt", content: "recovered\n" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Recovered."),
  ]);
  else if (phase === "after-answer") faux.setResponses([fauxAssistantMessage("Answer before an unfinished extension hook.")]);
  else faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'once\\n' >> receipt.txt" }), { stopReason: "toolUse" }),
    () => { ready(); return hang(); },
  ]);
  pi.registerProvider(faux.provider);
  pi.on("session_start", (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    timer = setInterval(() => {}, 1_000);
  });
  pi.on("session_shutdown", () => { clearInterval(timer); });
  if (phase === "input-gap") pi.on("context", async () => { ready(); await hang(); });
  if (phase === "after-answer") pi.on("agent_before_settle", async () => { ready(); return hang(); });
}
