Update `src/contact.mjs` in two places:

1. `displayName(profile)` should return a trimmed, non-empty nickname when one is provided. Otherwise, join the trimmed first and last names with one space. Return an empty string when all three values are empty.
2. `normalizePhone(value)` should remove formatting characters. Return a leading `+` for an already international number with 8–15 digits, add `+1` to a 10-digit North American number, and add `+` to an 11-digit number beginning with `1`. Return `null` for other inputs.

Keep the existing `priorityLabel` behavior. Run `npm test` before finishing and leave the source tree in a working state.
