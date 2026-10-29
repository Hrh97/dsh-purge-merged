// The Qoder CN patch injects lib/qoder/purge-prompt.zh.md as three system prompts,
// so that file must be the kernel prompt minus its fake chat-template wrapper.
// Without this guard, a kernel edit lands in DSH and Qoder silently keeps running
// the previous generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQoderPrompt, SRC, DST } from '../scripts/sync-qoder-prompt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('qoder prompt is generated from the kernel prompt', () => {
  const kernel = fs.readFileSync(SRC, 'utf8');
  const qoder = fs.readFileSync(DST, 'utf8');
  assert.equal(qoder, toQoderPrompt(kernel), 'run: node scripts/sync-qoder-prompt.mjs');
});

test('qoder prompt carries no chat-template wrapper', () => {
  const qoder = fs.readFileSync(DST, 'utf8');
  assert.ok(!/<\|im_start\|>/.test(qoder), 'qoder takes a plain system string');
  assert.ok(!/<project_instructions>/.test(qoder));
  assert.ok(qoder.startsWith('[OPERATION: STABLE]'), 'body starts at the kernel body');
});

test('every kernel section is present in the qoder prompt', () => {
  const heads = (s) => s.split('\n').filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.trim());
  const kernel = heads(fs.readFileSync(SRC, 'utf8'));
  const qoder = heads(fs.readFileSync(DST, 'utf8'));
  assert.ok(kernel.length >= 20, `kernel has ${kernel.length} sections`);
  assert.deepEqual(qoder, kernel);
});

test('the qoder patcher reads this exact file', () => {
  const patcher = fs.readFileSync(path.join(ROOT, 'lib', 'qoder', 'qoder-purge.mjs'), 'utf8');
  assert.match(patcher, /const PURGE_MD = path\.join\(__dirname, 'purge-prompt\.zh\.md'\)/);
  assert.match(patcher, /fs\.readFileSync\(PURGE_MD, 'utf8'\)/);
});
