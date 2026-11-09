#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 2;
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const inputPaths = args.filter((arg) => arg !== '--json');
if (inputPaths.length !== 1 || inputPaths[0].startsWith('-')) {
  fail('summary_input_required');
} else {
  try {
    const events = JSON.parse(readFileSync(inputPaths[0], 'utf8'));
    if (!Array.isArray(events) || events.some((event) => !['error', 'warning'].includes(event?.level))) {
      throw new Error('summary_input_invalid');
    }
    const summary = {
      errors: events.filter((event) => event.level === 'error').length,
      warnings: events.filter((event) => event.level === 'warning').length,
    };
    process.stdout.write(json
      ? `${JSON.stringify(summary)}\n`
      : `Errors: ${summary.errors}, Warnings: ${summary.warnings}\n`);
  } catch {
    fail('summary_input_invalid');
  }
}
