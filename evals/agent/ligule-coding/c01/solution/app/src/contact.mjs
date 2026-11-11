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
  // 只允许电话格式字符；字母和其他文字不是格式字符，出现就说明这不是一个可规范化的号码。
  if (!/^\+?[0-9 ().-]+$/u.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/gu, '');
  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function priorityLabel(value) {
  return value.trim().toUpperCase();
}
