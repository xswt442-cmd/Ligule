Update `src/contact.mjs` in two places:

1. `displayName(profile)` should return a trimmed, non-empty nickname when one is provided. Otherwise, join the trimmed first and last names with one space. Return an empty string when all three values are empty.
2. `normalizePhone(value)` should accept digits, one optional leading `+` for an international number, and spaces, parentheses, periods, or hyphens as formatting. Reject any letter or unsupported character rather than silently discarding it. Return a leading `+` for an already international number with 8–15 digits, add `+1` to a 10-digit North American number, and add `+` to an 11-digit number beginning with `1`. Return `null` for other inputs.

Keep the existing `priorityLabel` behavior and leave the source tree in a working state. Do not run project tests or build commands. The separate verifier will run the test suite after your turn.
