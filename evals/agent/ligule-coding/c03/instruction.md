`npm test` currently fails because `slugify` removes numeric characters. Fix the regression in `src/slug.mjs`.

Keep letters and numbers, normalize accented Latin characters, replace punctuation runs with one hyphen, and trim leading or trailing hyphens. Preserve `normalizeLabel` behavior. Run `npm test` before finishing.
