Add `PATCH /api/items/:id` to `src/server.mjs` and update `test/server.test.mjs` to cover the new route.

- Accept a JSON object with a string `name`; trim it and require 1–80 characters.
- Return `200` and the updated item for a valid existing ID.
- Return `400` for invalid JSON or an empty/overlong name without changing the item.
- Return `404` for an unknown item ID.
- Keep the existing GET route behavior.

Keep the route implementation and its regression test changes in separate files. Do not run project tests or build commands. The separate verifier will run the test suite after your turn.
