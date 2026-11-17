# Pi Durable Harness

Recover interrupted Pi sessions without replacing your agent.

- **Normal Pi:** keep your subscription authentication, models, tools, skills, and interface.
- **Persisted runs:** Pi Durable tracks unfinished work in SQLite alongside Pi's session history.
- **Resume in place:** continue the same conversation and use the files already produced.
- **Respect controls:** explicitly stopped runs stay stopped; completion follows Pi's settled-run boundary.
- **Minimal integration:** no research workflow, agent manager, fixed roles, or replacement UI.

## Install

Requires Node.js ≥22.19, Pi ≥1.5, and macOS or Linux.

```sh
pi install npm:@harrarz/pi-durable-harness
```

Use Pi's existing `/login` and `/model` as usual. No additional authentication setup.

## Use

Work in Pi normally. To reopen the latest session:

```sh
pi --continue
```

For headless recovery, wait for the pending work explicitly:

```sh
pi --mode json --continue /durable-resume
```

Use `--session /path/to/session.jsonl` instead of `--continue` to select an exact session. With [Pi Agnostic Subagents](https://github.com/harrarz/pi-agnostic-subagents), choose inherited user extensions or a trusted custom set for workers.

## Know the boundaries

- This recovers work **inside a reopened Pi session**. Your process host, operator, or existing subagent integration still starts/restarts processes.
- Recovery uses Pi's saved history and files, not transactional replay of every tool. External side effects are not exactly-once.
- Enable the extension in each worker that needs recovery. Unconsumed in-memory message queues are not made durable.

## Development

```sh
npm ci
npm run check           # typecheck, offline tests, package-content checks
npm run test:package    # install a tarball and exercise it through the real Pi CLI
pi -e ./src/index.ts    # one-off local trial
```

Provider-backed checks are separately opt-in and use your existing Codex subscription; see the guide before running them.

[Configuration and recovery](docs/configuration.md) · [MIT license](LICENSE)
