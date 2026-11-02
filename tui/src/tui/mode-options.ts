import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { KernelError, type ModeDirectories, type ModeLayer } from '@ligule/core/tui.js';

export type ModeOption = { name: string; layer: ModeLayer };

const LAYERS: readonly ModeLayer[] = ['shipped', 'user', 'project'];

function modeNameOf(filename: string): string | undefined {
  if (!filename.endsWith('.toml')) return undefined;
  const name = filename.slice(0, -'.toml'.length);
  if (name.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/u.test(name)) return undefined;
  return name;
}

function listError(layer: ModeLayer, cause: unknown): KernelError {
  return new KernelError('mode_list_failed', { cause, detail: `could not list ${layer} modes` });
}

async function namesIn(directory: string, layer: ModeLayer): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw listError(layer, cause);
  }

  const names: string[] = [];
  for (const entry of entries) {
    const name = modeNameOf(entry.name);
    if (name === undefined) continue;
    if (entry.isFile()) {
      names.push(name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      if ((await stat(join(directory, entry.name))).isFile()) names.push(name);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw listError(layer, cause);
    }
  }
  return names;
}

export async function modeOptions(paths: ModeDirectories): Promise<readonly ModeOption[]> {
  const available = new Map<string, ModeLayer>();
  for (const layer of LAYERS) {
    const directory = paths[layer];
    for (const name of await namesIn(directory, layer)) available.set(name, layer);
  }
  return [...available]
    .map(([name, layer]) => ({ name, layer }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}
