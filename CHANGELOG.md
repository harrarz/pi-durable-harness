# Changelog

## [0.1.0]

- Publish the minimal Pi + Pi Durable integration as `@harrarz/pi-durable-harness`.
- Track outstanding Pi runs in SQLite and recover them in their original saved sessions without replacing Pi's authentication, tools, or agent loop.
- Add `/durable-resume` for awaited headless recovery, reconcile interrupted receipt admission, and record completion only at Pi's settled-run boundary.
- Preserve explicit cancellation, stop inference on persistence failure, and enforce a single Durable writer.
- Add offline crash/cancellation regressions, opt-in live manager/worker fault tests, clean tarball checks, MIT licensing, and macOS/Linux CI.
