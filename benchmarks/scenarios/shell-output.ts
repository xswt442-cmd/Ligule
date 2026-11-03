import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bindScript } from '../../core/dist/capability/script-binding.js';
import { execTool } from '../../core/dist/capability/exec.js';
import { resolveShell, withNativeExitCode } from '../../core/dist/index.js';
import { DEFAULT_LIMITS } from '../../core/dist/capability/limits.js';
import { createPermissionContext } from '../../core/dist/kernel/permission.js';
import type { Scenario, ScenarioResult, Sample } from '../lib.ts';

const OUTPUTS = [1 * 1024 * 1024, 5 * 1024 * 1024] as const;
const EXEC_BYTES = DEFAULT_LIMITS.execBytes;

function generateCommand(bytes: number): string {
  return `node -e "process.stdout.write('x'.repeat(${bytes}))"`;
}

export const shellOutput: Scenario = {
  name: 'shell-output',
  async run({ repeats, warmup, workRoot }): Promise<ScenarioResult> {
    const workspace = join(workRoot, 'shell-workspace');
    await mkdir(workspace, { recursive: true });
    const shell = resolveShell({});
    const permission = createPermissionContext('full-access', 'unrestricted', {
      filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
    }, { workspaceTrusted: true });
    const samples: Sample[] = [];
    const runOutput = async (bytes: number, record: boolean): Promise<void> => {
      const command = generateCommand(bytes);
      const scriptBinding = await bindScript({ command, shell, boundary: workspace, workspaceRoot: workspace, cwd: workspace, permission });
      const rssBefore = process.memoryUsage().rss;
      const started = performance.now();
      const result = await execTool.run({ command }, {
        config: { boundary: workspace },
        permission,
        shell: withNativeExitCode(shell, command),
        ...(scriptBinding === undefined ? {} : { scriptBinding }),
      });
      const durationMs = performance.now() - started;
      const rssDeltaBytes = process.memoryUsage().rss - rssBefore;
      if (result.exitCode !== 0) throw new Error(`shell_output_exit:${String(result.exitCode)}`);
      if (result.text.length <= 0) throw new Error('shell_output_empty');
      if (record) {
        samples.push({
          outputBytes: bytes,
          durationMs,
          rssDeltaBytes,
          returnedTextCharacters: result.text.length,
          durationMsPerMiB: durationMs / (bytes / (1024 * 1024)),
        });
      }
    };
    try {
      for (let index = 0; index < warmup; index += 1) {
        for (const bytes of OUTPUTS) await runOutput(bytes, false);
      }
      for (let index = 0; index < repeats; index += 1) {
        for (const bytes of OUTPUTS) await runOutput(bytes, true);
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
      if (code?.startsWith('exec_permission') === true || code === 'execution_backend_unavailable') {
        return { name: this.name, status: 'blocked', reason: `${code}: ${error instanceof Error ? error.message : String(error)}`, samples: [] };
      }
      throw error;
    }
    const bySize = new Map<number, number[]>();
    for (const sample of samples) {
      const size = Number(sample.outputBytes);
      const duration = Number(sample.durationMs);
      bySize.set(size, [...(bySize.get(size) ?? []), duration]);
    }
    const notes: Record<string, unknown> = { execBytes: EXEC_BYTES, shell: shell.kind };
    const small = bySize.get(OUTPUTS[0]) ?? [];
    const large = bySize.get(OUTPUTS[1]) ?? [];
    if (small.length > 0 && large.length > 0) {
      notes.scalingRatio5xTo1x = (large.reduce((sum, value) => sum + value, 0) / large.length)
        / (small.reduce((sum, value) => sum + value, 0) / small.length);
    }
    return { name: this.name, status: 'ok', samples, notes };
  },
};
