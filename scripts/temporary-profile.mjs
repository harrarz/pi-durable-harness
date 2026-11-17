// Opt-in live-test fixture: add one uniquely named profile, never alter defaults, restore afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function temporaryProfile(agentDir, profile, backupDir) {
  const file = join(agentDir, "agent-supervisor", "profiles.json");
  let original, mode = 0o600;
  try { original = await readFile(file, "utf8"); mode = (await stat(file)).mode & 0o777; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = original === undefined ? {} : JSON.parse(original);
  assert.ok(config && typeof config === "object" && !Array.isArray(config));
  assert.ok(config.profiles === undefined || (config.profiles && typeof config.profiles === "object"));
  const name = `durable-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const updated = { ...config, profiles: { ...(config.profiles ?? {}), [name]: profile } };
  const content = JSON.stringify(updated, null, 2) + "\n";
  const backup = join(backupDir, "trusted-profiles.backup");
  if (original !== undefined) await writeFile(backup, original, { mode: 0o600 });
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const atomicWrite = async (contents) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, contents, { mode }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  };
  await atomicWrite(content);
  let restored = false;
  return {
    name,
    async restore() {
      if (restored) return;
      const current = await readFile(file, "utf8");
      if (current === content) {
        if (original === undefined) await rm(file);
        else await atomicWrite(original);
      } else {
        // Preserve unrelated concurrent operator edits; remove only our unmodified alias.
        const latest = JSON.parse(current);
        assert.notEqual(latest.defaultProfile, name, "Test profile became the default; refusing to change operator choices.");
        assert.deepEqual(latest.profiles?.[name], profile, "Temporary profile changed; refusing to overwrite operator edits.");
        delete latest.profiles[name];
        await atomicWrite(JSON.stringify(latest, null, 2) + "\n");
      }
      restored = true;
      await rm(backup, { force: true });
    },
  };
}
