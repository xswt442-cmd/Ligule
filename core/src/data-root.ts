import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { KernelError } from './errors.js';

// The single resolver for Ligule's user data root.
export function dataRoot(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const written = typeof env.LIGULE_HOME === 'string' ? env.LIGULE_HOME.trim() : '';
  if (written === '') return join(home, '.ligule');
  if (!isAbsolute(written)) {
    throw new KernelError('data_root_invalid', { detail: `LIGULE_HOME must name an absolute directory, got "${env.LIGULE_HOME}"` });
  }
  return written;
}
