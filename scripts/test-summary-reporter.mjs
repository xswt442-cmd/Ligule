import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportRoot = resolve(process.env.LIGULE_TEST_REPORT_DIR ?? join(repository, 'testplace', 'test-reports'));
const outputByFile = new Map();
const stderrByFile = new Map();
const completedFiles = new Map();
const failures = [];
let summary;

function remember(target, file, channel, message) {
  if (typeof message !== 'string' || message === '') return;
  const key = typeof file === 'string' ? file : '(runner)';
  const existing = target.get(key) ?? [];
  existing.push(`[${channel}] ${message}`);
  target.set(key, existing);
}

function relativeFile(file) {
  return typeof file === 'string' ? relative(repository, file) || basename(file) : '(unknown test file)';
}

function failureText(failure) {
  const data = failure.data;
  const details = data.details ?? {};
  const error = details.error ?? {};
  const cause = error.cause;
  const location = `${relativeFile(data.file)}${data.line === undefined ? '' : `:${data.line}`}`;
  const stack = typeof error.stack === 'string' ? error.stack
    : typeof error.message === 'string' ? error.message : String(error);
  const causeStack = cause !== undefined && typeof cause.stack === 'string' && !stack.includes(cause.stack)
    ? `\nCaused by:\n${cause.stack}` : '';
  const diagnostics = [error, cause].flatMap((entry) => {
    if (entry === undefined || entry === null || typeof entry !== 'object') return [];
    const fields = [];
    for (const key of ['code', 'detail', 'diagnostics']) {
      if (key in entry && entry[key] !== undefined) fields.push(`${key}: ${typeof entry[key] === 'string' ? entry[key] : JSON.stringify(entry[key])}`);
    }
    return fields;
  });
  return `✖ ${data.name ?? '(unnamed test)'} (${location})\n${stack}${causeStack}${diagnostics.length === 0 ? '' : `\n${diagnostics.join('\n')}`}`;
}

export default new Transform({
  writableObjectMode: true,
  transform(event, _encoding, callback) {
    const data = event?.data ?? {};
    if (event?.type === 'test:fail') failures.push(event);
    else if (event?.type === 'test:stdout' || event?.type === 'test:stderr' || event?.type === 'test:diagnostic') {
      if (event.type === 'test:stderr') remember(stderrByFile, data.file, 'stderr', data.message);
      if (completedFiles.get(data.file) !== true) {
        const channel = event.type === 'test:stdout' ? 'stdout' : event.type === 'test:stderr' ? 'stderr' : `diagnostic:${data.level ?? 'info'}`;
        remember(outputByFile, data.file, channel, data.message);
      }
    }
    else if (event?.type === 'test:summary') {
      if (typeof data.file === 'string') {
        const counts = data.counts ?? {};
        const duration = Number.isFinite(data.duration_ms) ? `, ${Math.round(data.duration_ms)} ms` : '';
        this.push(`${relativeFile(data.file)}: ${counts.passed ?? 0}/${counts.tests ?? 0} passed, ${counts.failed ?? 0} failed, ${counts.skipped ?? 0} skipped${duration}\n`);
        completedFiles.set(data.file, data.success === true);
        if (data.success === true) outputByFile.delete(data.file);
      } else summary = data;
    }
    callback();
  },
  flush(callback) {
    void (async () => {
      const counts = summary?.counts ?? {};
      const failed = failures.length > 0 || summary?.success !== true;
      const duration = Number.isFinite(summary?.duration_ms) ? `, ${Math.round(summary.duration_ms)} ms` : '';
      const line = `${failed ? 'FAIL' : 'PASS'} ${counts.passed ?? 0}/${counts.tests ?? 0} passed, ${counts.failed ?? failures.length} failed, ${counts.skipped ?? 0} skipped${duration}`;
      this.push(`${line}\n`);
      if (!failed) return;

      const failedFiles = new Set(failures.map((failure) => failure.data.file).filter((file) => typeof file === 'string'));
      const report = [line, ...(failures.length === 0 ? ['Node test runner ended without a final summary event.'] : failures.map(failureText))];
      for (const [file, messages] of outputByFile) {
        report.push(`\n--- output from ${relativeFile(file)} ---`, ...messages);
      }
      for (const [file, messages] of stderrByFile) {
        if (failedFiles.has(file)) continue;
        report.push(`\n--- stderr from ${relativeFile(file)} ---`, ...messages);
      }
      const name = `${basename(process.cwd())}-${Date.now()}-${randomUUID()}.log`;
      const path = resolve(reportRoot, name);
      await mkdir(reportRoot, { recursive: true });
      await writeFile(path, `${report.join('\n')}\n`, 'utf8');
      this.push(`Test failure details: ${relative(repository, path)}\n`);
      this.push(`${report.join('\n')}\n`);
    })().then(() => callback(), (error) => callback(error));
  },
});
