# Configuration and recovery

## Sessions

Install through Pi, then work normally. Pi handles models, subscription credentials, tools, skills, and extensions. This package adds persisted run receipts and `/durable-resume`; it does not replace Pi's agent loop.

Interactive and RPC sessions resume pending work when reopened with the extension enabled:

```sh
pi --continue
pi --session /path/to/session.jsonl
```

Headless print/JSON mode needs an awaited command:

```sh
pi --mode json --session /path/to/session.jsonl /durable-resume
```

A bare headless `--continue` has no prompt to await and can exit without recovering work. `/durable-resume` waits for pending runs and Pi to settle. It makes no model request when nothing is pending.

Pi's `--no-session` mode has no persistent history, so the extension disables recovery for it.

## State and interruption

SQLite and the writer lock live at `<session.jsonl>.durable/`. Keep this directory with its Pi session file and retain the project files needed to continue. No credentials are copied into the Durable database.

Only Pi's `agent_settled` boundary records completion. An answer before that boundary may still have extension continuations pending. After an ambiguous interruption, Pi gets a continuation/verification message asking it to inspect existing work rather than blindly repeat commands.

Explicitly cancelled runs remain stopped. Provider failures are recorded rather than automatically retried forever. A stale crash lock can take about 10–12 seconds to clear. Persistence failures stop inference instead of silently continuing without recovery.

One process writes a session's Durable state at a time. This is not a security sandbox, an exactly-once side-effect guarantee, or a backup system.

## Workers

Install the package as a user extension. With [Pi Agnostic Subagents](https://github.com/harrarz/pi-agnostic-subagents), choose inherited extensions in `/agent extensions`, or launch explicitly:

```js
agent_start({ task: "Investigate the parser", profile: "pi", extensions: "inherit" })
```

For a narrower selection, create an approved extension set containing this package in `/agent extensions` and select `custom` mode. The bundled Pi profile supports these choices; older private profile overrides need the extension-selection capability described in the subagent extension's configuration guide.

Inheritance includes enabled user extensions, not temporary parent `-e` additions. Install normally before using it for workers. Enabling persistence does not restart a dead process: the process host/operator/subagent integration must reopen the saved worker session.

## Development and verification

```sh
npm run check           # offline SDK/actual-CLI regressions and publication allowlist
npm run test:package    # clean tarball installation and actual-CLI loading; npm access required
npm run smoke           # live Codex authentication/tool check
npm run smoke:recovery  # live SIGKILL + headless recovery
npm run smoke:agents    # real manager and two workers; interrupt/resume manager
npm run smoke:workers   # temporary trusted profile; interrupt/resume worker and manager
```

Live checks require your existing Codex subscription. Worker checks also require the existing subagent extension. `PI_SUPERVISOR_EXTENSION=/absolute/path/to/its/src/index.ts` selects it explicitly for the test. `PI_SMOKE_CLI=pi npm run smoke` checks the Pi executable on PATH.

The worker fault test temporarily adds a uniquely named trusted profile, never changes the default, and removes it afterwards. It uses minimal thinking for test calls without changing user settings, verifies process identity before signalling, and has a 210-second overall limit. Test files and transcripts remain in private temporary directories outside the checkout. Do not run provider-backed checks unless you intend to consume subscription quota.

Local verification covered Pi 1.5.0/1.5.2 on macOS, offline crash/cancellation cases, and a real Pi manager plus two Pi workers using the Codex subscription. The active worker reopened its original conversation, retained its intermediate checkpoint, and did not repeat its recorded side effect. The manager then recovered too. CI checks supported Node versions on macOS and Linux; these checks are not a multi-day reliability guarantee or validation of arbitrary research.
