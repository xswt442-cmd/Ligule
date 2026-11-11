export function slugify(value) {
  return value.normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

export function normalizeLabel(value) {
  return value.trim().replace(/\s+/gu, ' ');
}
