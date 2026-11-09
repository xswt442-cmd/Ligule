#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (typeof file !== 'string' || file === '') {
  process.stderr.write('summary_input_required\n');
  process.exitCode = 2;
} else {
  try {
    const events = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(events)) throw new Error('events_must_be_array');
    const errors = events.filter((event) => event.level === 'error').length;
    const warnings = events.filter((event) => event.level === 'warning').length;
    process.stdout.write(`Errors: ${errors}, Warnings: ${warnings}\n`);
  } catch {
    process.stderr.write('summary_input_invalid\n');
    process.exitCode = 2;
  }
}
