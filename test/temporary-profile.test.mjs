import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { temporaryProfile } from "../scripts/temporary-profile.mjs";

const profile = { executable: "pi", args: [], taskTransport: "stdin" };

test("temporary trusted profile restores the exact existing configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-profile-test-"));
  const file = join(directory, "agent-supervisor/profiles.json");
  await mkdir(join(directory, "agent-supervisor"));
  const original = '{"defaultProfile":"pi", "profiles":{}}\n';
  await writeFile(file, original);
  try {
    const temporary = await temporaryProfile(directory, profile, directory);
    assert.equal(JSON.parse(await readFile(file, "utf8")).defaultProfile, "pi");
    await temporary.restore();
    await temporary.restore();
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("temporary trusted profile removes a newly created profile file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-profile-test-"));
  try {
    const temporary = await temporaryProfile(directory, profile, directory);
    await temporary.restore();
    await assert.rejects(readFile(join(directory, "agent-supervisor/profiles.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("temporary profile cleanup preserves unrelated concurrent edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-profile-test-"));
  const file = join(directory, "agent-supervisor/profiles.json");
  try {
    const temporary = await temporaryProfile(directory, profile, directory);
    const changed = JSON.parse(await readFile(file, "utf8"));
    changed.profiles.unrelated = { ...profile, executable: "another-agent" };
    await writeFile(file, JSON.stringify(changed));
    await temporary.restore();
    const restored = JSON.parse(await readFile(file, "utf8"));
    assert.ok(!Object.hasOwn(restored.profiles, temporary.name));
    assert.equal(restored.profiles.unrelated.executable, "another-agent");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
