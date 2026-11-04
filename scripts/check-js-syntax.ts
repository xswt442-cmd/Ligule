import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_ROOTS: readonly string[] = ['core/src', 'tui/src', 'desktop', 'scripts', 'tests', 'core/tests', 'tui/tests'];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'vendor', 'release', 'testplace']);

export type SyntaxFailure = { file: string; output: string };

export function collectJavaScriptFiles(root: string = REPOSITORY_ROOT, directories: readonly string[] = SOURCE_ROOTS): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry.name))) {
        found.push(join(directory, entry.name));
      }
    }
  };

  for (const relativeDirectory of directories) {
    const directory = resolve(root, relativeDirectory);
    if (!statSync(directory).isDirectory()) throw new Error(`syntax scan root is not a directory: ${relativeDirectory}`);
    visit(directory);
  }
  return [...new Set(found)].sort();
}

export function checkJavaScriptFiles(files: readonly string[], node: string = process.execPath): SyntaxFailure[] {
  const failures: SyntaxFailure[] = [];
  for (const file of files) {
    const result = spawnSync(node, ['--check', file], { encoding: 'utf8', windowsHide: true });
    if (result.error !== undefined || result.status !== 0) {
      failures.push({
        file,
        output: `${result.stderr ?? ''}${result.stdout ?? ''}${result.error?.message ?? ''}`.trim(),
      });
    }
  }
  return failures;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = collectJavaScriptFiles();
  const failures = checkJavaScriptFiles(files);
  for (const failure of failures) process.stderr.write(`${failure.file}\n${failure.output}\n`);
  if (failures.length > 0) process.exitCode = 1;
  else process.stdout.write(`JavaScript syntax check passed: ${files.length} files (.js, .mjs, .cjs)\n`);
}
