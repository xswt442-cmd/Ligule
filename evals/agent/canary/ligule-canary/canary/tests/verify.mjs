import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_CONTENT = 'LIGULE-CANARY-OK\n';

export async function verify(workspace) {
  let content;
  try {
    content = await readFile(join(workspace, 'answer.txt'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('handoff_output_missing');
    throw new Error('handoff_output_unreadable');
  }
  if (content === '') throw new Error('handoff_output_empty');
  if (content !== EXPECTED_CONTENT) throw new Error('handoff_output_mismatch');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const workspace = process.argv[2];
    if (typeof workspace !== 'string' || workspace.trim() === '') throw new Error('handoff_workspace_required');
    await verify(workspace);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'handoff_verifier_failed'}\n`);
    process.exitCode = 1;
  }
}
