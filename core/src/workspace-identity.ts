import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { KernelError } from './errors.js';

export interface CanonicalWorkspace {
  readonly identity: string;
  readonly directory: string;
}

/** Normalize a directory identity without requiring that the directory already exists. */
export function canonicalWorkspaceOf(directory: string): CanonicalWorkspace {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new KernelError('workspace_directory_required', { detail: String(directory) });
  }
  const asked = resolve(directory);
  let real = asked;
  try {
    real = realpathSync(asked);
  } catch {
    real = asked;
  }
  const unrooted = real.startsWith('\\\\?\\') ? real.slice(4) : real;
  if (process.platform === 'win32') {
    const stripped = trimTrailingSeparators(unrooted, 'windows');
    const rooted = /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped;
    return { identity: rooted.toLowerCase(), directory: rooted };
  }
  const rooted = trimTrailingSeparators(unrooted);
  return { identity: rooted === '' ? '/' : rooted, directory: rooted };
}

/** Remove trailing separators with a linear scan so long paths cannot trigger regex backtracking. */
export function trimTrailingSeparators(value: string, kinds: 'slash' | 'windows' = 'slash'): string {
  let end = value.length;
  while (end > 0) {
    const last = value[end - 1];
    if (last !== '/' && (kinds === 'slash' || last !== '\\')) break;
    end -= 1;
  }
  return value.slice(0, end);
}

export function workspaceIdentity(directory: string): string {
  return canonicalWorkspaceOf(directory).identity;
}
