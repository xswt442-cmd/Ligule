Add an optional `--json` flag to `bin/summary.mjs`.

- Without the flag, preserve the current human-readable output.
- With the flag before or after the input path, print one JSON object with `errors` and `warnings` counts.
- Reject a missing input path, invalid JSON, unknown event levels, and unrecognized arguments with exit code 2 and a concise stderr message.
- Update `test/summary.test.mjs` for the CLI behavior, then run `npm test`.
