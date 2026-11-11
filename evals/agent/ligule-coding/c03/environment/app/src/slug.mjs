export function slugify(value) {
  return value.trim().toLowerCase().replace(/\d+/gu, '').replace(/[^a-z]+/gu, '-').replace(/^-+|-+$/gu, '');
}

export function normalizeLabel(value) {
  return value.trim().replace(/\s+/gu, ' ');
}
