import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

export type SystemTrashExpected =
  | { type: 'file'; content: string }
  | { type: 'directory'; content: string; relativePath: string[] };

export type SystemTrashOptions = { allowSuffix?: boolean; root?: string };

export type SystemTrashEntry = { root: string; infoPath: string; payloadPath: string };

function errorCodeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
}

async function mountPointFor(target: string): Promise<string> {
  let current = resolve(target);
  let currentStat;
  try { currentStat = await stat(current); }
  catch (error) {
    if (errorCodeOf(error) !== 'ENOENT') throw error;
    current = dirname(current);
    currentStat = await stat(current);
  }
  for (;;) {
    const parent = dirname(current);
    if (parent === current || (await stat(parent)).dev !== currentStat.dev) return current;
    current = parent;
  }
}

async function trashRootsFor(target: string): Promise<{ root: string; originalPath: string }[]> {
  const absoluteTarget = resolve(target);
  const mountPoint = await mountPointFor(absoluteTarget);
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const uid = String(process.getuid?.());
  return [
    { root: join(dataHome, 'Trash'), originalPath: absoluteTarget },
    { root: join(mountPoint, `.Trash-${uid}`), originalPath: relative(mountPoint, absoluteTarget) },
    { root: join(mountPoint, '.Trash', uid), originalPath: relative(mountPoint, absoluteTarget) },
  ];
}

function encodeTrashPath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export async function findSystemTrashEntry(target: string, { allowSuffix = false, root }: SystemTrashOptions = {}): Promise<SystemTrashEntry | undefined> {
  const name = basename(resolve(target));
  const candidates = (await trashRootsFor(target)).filter((candidate) => root === undefined || candidate.root === root);
  for (const candidate of candidates) {
    const infoDirectory = join(candidate.root, 'info');
    const suffixStem = basename(resolve(target), extname(name));
    let infoNames: string[];
    try {
      infoNames = allowSuffix
        ? (await readdir(infoDirectory)).filter((entry) => entry.startsWith(suffixStem) && entry.endsWith('.trashinfo'))
        : [`${name}.trashinfo`];
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT' || errorCodeOf(error) === 'ENOTDIR') continue;
      throw error;
    }
    for (const infoName of infoNames) {
      const infoPath = join(infoDirectory, infoName);
      let info: string;
      try { info = await readFile(infoPath, 'utf8'); }
      catch (error) {
        if (errorCodeOf(error) === 'ENOENT' || errorCodeOf(error) === 'ENOTDIR') continue;
        throw error;
      }
      const original = info.match(/^Path=(.*)$/m)?.[1];
      const acceptedPaths = new Set([candidate.originalPath, encodeTrashPath(candidate.originalPath)]);
      let decoded: string | undefined;
      try { decoded = original?.split('/').map(decodeURIComponent).join('/'); }
      catch { decoded = undefined; }
      if (original === undefined || (!acceptedPaths.has(original) && (decoded === undefined || !acceptedPaths.has(decoded)))) continue;
      const payloadName = infoName.slice(0, -'.trashinfo'.length);
      return { root: candidate.root, infoPath, payloadPath: join(candidate.root, 'files', payloadName) };
    }
  }
  return undefined;
}

export async function removeSystemTrashEntry(entry: SystemTrashEntry, expected: SystemTrashExpected): Promise<void> {
  if (expected.type === 'file') {
    assert.equal(await readFile(entry.payloadPath, 'utf8'), expected.content);
  } else {
    assert.equal(await readFile(join(entry.payloadPath, ...expected.relativePath), 'utf8'), expected.content);
  }
  await rm(entry.payloadPath, { recursive: expected.type === 'directory' });
  await rm(entry.infoPath);
}

export async function cleanSystemTrashEntry(target: string, expected: SystemTrashExpected, {
  allowSuffix = false, required = false, root,
}: SystemTrashOptions & { required?: boolean } = {}): Promise<void> {
  const entry = await findSystemTrashEntry(target, { allowSuffix, root });
  if (entry === undefined) {
    if (required) assert.fail(`system trash did not expose the item created for ${target}`);
    return;
  }
  await removeSystemTrashEntry(entry, expected);
}
