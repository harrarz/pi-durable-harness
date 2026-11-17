# Project guidance

Read `README.md` and `docs/configuration.md` before changing behaviour.

Keep this a minimal integration: Pi owns reasoning, authentication, tools, and subagents; Durable tracks recovery. Do not add a replacement agent loop, research workflow, fixed roles, scheduler, or UI.

Treat run receipts and Pi lifecycle boundaries as compatibility contracts. Do not infer completion from an assistant answer or promise exactly-once external effects. Keep credentials, runtime state, transcripts, and local planning/validation notes out of Git and npm.

Keep documentation concise. Run `npm run check` before reporting changes; run `npm run test:package` before publishing. Provider-backed checks are opt-in and must leave trusted profiles/defaults unchanged after cleanup.
