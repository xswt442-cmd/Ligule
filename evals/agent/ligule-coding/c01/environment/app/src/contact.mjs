export function displayName(profile) {
  return `${profile.firstName ?? ''} ${profile.lastName ?? ''}`;
}

export function normalizePhone(value) {
  return value.replace(/\s+/gu, '');
}

export function priorityLabel(value) {
  return value.trim().toUpperCase();
}
