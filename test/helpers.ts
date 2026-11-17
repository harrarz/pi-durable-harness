import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, type FauxResponseStep, type RegisterFauxProviderOptions } from "@earendil-works/pi-ai/providers/faux";
import durablePi from "../src/index.ts";

export async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function openPi(directory: string, responses: FauxResponseStep[], sessionFile?: string,
  extensions: ExtensionFactory[] = [], fauxOptions: RegisterFauxProviderOptions = {}) {
  const agentDir = join(directory, "pi-config");
  await mkdir(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider(fauxOptions);
  faux.setResponses(responses);
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: "always",
  });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [durablePi, ...extensions],
  });
  await loader.reload();
  const manager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(directory, join(directory, "sessions"));
  const { session } = await createAgentSession({
    cwd: directory, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
    sessionManager: manager, settingsManager: settings, resourceLoader: loader,
  });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
  return { session, manager, faux, errors };
}

export async function closePi(session: AgentSession) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
