import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Decision = 'allow' | 'deny' | 'ask-human';
type ReviewerCase = {
  id: string;
  expected: Decision;
  tags?: string[];
  category?: string;
  facts?: {
    policyMode?: string;
    permission?: string;
    boundary?: string;
    workspaceTrusted?: boolean;
    constraints?: string[];
    tool?: { name?: string; input?: unknown };
  };
  pending?: { name?: string; input?: unknown };
  rounds?: string[];
};
type ReviewerControl = {
  id: string;
  expected: Decision;
  tags: string[];
  control: string;
};

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureDirectory, name), 'utf8')) as T;
}

test('the P7 Reviewer regression set has at least 60 labeled cases and required risk coverage', async () => {
  const p10 = await readJson<ReviewerCase[]>('reviewer-v013-p10-cases.json');
  const w2w3 = await readJson<{ cases: ReviewerCase[] }>('reviewer-v013-w2w3-cases.json');
  const expansion = await readJson<ReviewerCase[]>('reviewer-v013-cases.json');
  const controls = await readJson<ReviewerControl[]>('reviewer-v013-controls.json');
  const cases = [...p10, ...w2w3.cases, ...expansion];
  const ids = [...cases, ...controls].map((entry) => entry.id);

  assert.equal(p10.length, 20);
  assert.equal(w2w3.cases.length, 8);
  assert.ok(cases.length >= 60);
  assert.equal(controls.length, 10);
  assert.equal(new Set(ids).size, ids.length, 'case and control IDs must be unique');
  assert.ok(cases.every((entry) => entry.id.length > 0));

  const counts = Object.fromEntries((['allow', 'deny', 'ask-human'] as const).map((decision) => [
    decision, cases.filter((entry) => entry.expected === decision).length,
  ]));
  assert.ok(Object.values(counts).every((count) => count >= 20), 'every decision label must have at least 20 cases');
  assert.ok(controls.every((entry) => entry.expected === 'ask-human' && entry.control.length > 0));

  for (const entry of p10) {
    assert.ok(entry.facts?.policyMode && entry.facts.permission && entry.facts.boundary);
    assert.ok(entry.facts.tool?.name && entry.facts.tool.input !== undefined);
  }
  for (const entry of w2w3.cases) {
    assert.ok(entry.pending?.name && entry.pending.input !== undefined);
  }
  for (const entry of expansion) {
    assert.ok(entry.category && entry.facts?.policyMode && entry.facts.permission && entry.facts.boundary);
    assert.equal(typeof entry.facts.workspaceTrusted, 'boolean');
    assert.ok(entry.facts.tool?.name && entry.facts.tool.input !== undefined);
    assert.ok(Array.isArray(entry.facts.constraints));
  }

  const allTagged = [...cases, ...controls];
  const requiredCoverage: Readonly<Record<string, number>> = {
    'old-user-constraint': 8,
    'grant-change': 8,
    'cross-project': 6,
    'dangerous-wrapper': 8,
    'tool-output-injection': 8,
    'controller-impersonation': 6,
    'cancellation-late-result': 6,
    'model-timeout-unavailable': 4,
  };
  for (const [tag, minimum] of Object.entries(requiredCoverage)) {
    const count = allTagged.filter((entry) => entry.tags?.includes(tag)).length;
    assert.ok(count >= minimum, `${tag} has ${count} cases; expected at least ${minimum}`);
  }
});
