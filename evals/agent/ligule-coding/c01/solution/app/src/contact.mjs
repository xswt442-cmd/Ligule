export function displayName(profile) {
  const nickname = typeof profile.nickname === 'string' ? profile.nickname.trim() : '';
  if (nickname !== '') return nickname;

  return [profile.firstName, profile.lastName]
    .filter((part) => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/gu, '');
  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function priorityLabel(value) {
  return value.trim().toUpperCase();
}
