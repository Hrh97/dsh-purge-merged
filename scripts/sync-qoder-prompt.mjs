#!/usr/bin/env node
// sync-qoder-prompt.mjs — keep the Qoder CN purge prompt in lockstep with the kernel prompt.
//
// The Qoder patch (lib/qoder/qoder-purge.mjs) replaces three Electron system-prompt
// constants inside Qoder CN's app.asar. Whatever text lives in
// lib/qoder/purge-prompt.zh.md is what Qoder will run with, so it has to track
// lib/default-prompt-inject.zh.md — every kernel edit must land here too, or Qoder
// silently keeps running the previous generation of the prompt.
//
// The ONE intended difference: the kernel file starts with a fake chat-template
// wrapper (`<|im_start|>system:<project_instructions>` + a blank line) because
// dsh-purge injects it into a chat transcript. Qoder takes a plain system string,
// so those two lines are stripped. Everything after them must be byte-identical.
//
//   node scripts/sync-qoder-prompt.mjs           # rewrite the qoder prompt from the kernel
//   node scripts/sync-qoder-prompt.mjs --check   # exit 1 if they drifted (CI / test)
//   node scripts/sync-qoder-prompt.mjs --diff    # print the drift, write nothing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, 'lib', 'default-prompt-inject.zh.md');
export const DST = path.join(ROOT, 'lib', 'qoder', 'purge-prompt.zh.md');

const WRAPPER = /^<\|im_start\|>.*$|^<project_instructions>\s*$/;

/** Strip the fake chat-template wrapper the kernel needs and Qoder must not have. */
export function toQoderPrompt(kernelText) {
  const lines = String(kernelText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && WRAPPER.test(lines[i])) i++;
  // a single blank line right after the wrapper belongs to it
  if (i > 0 && lines[i] === '') i++;
  const out = lines.slice(i).join('\n').replace(/\s+$/, '');
  return `${out}\n`;
}

function firstDrift(a, b) {
  const al = a.split('\n'), bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) {
      return {
        line: i + 1,
        kernel: al[i] === undefined ? '(eof)' : al[i],
        qoder: bl[i] === undefined ? '(eof)' : bl[i],
      };
    }
  }
  return null;
}

function main(argv) {
  const check = argv.includes('--check');
  const diffOnly = argv.includes('--diff');
  const kernel = fs.readFileSync(SRC, 'utf8');
  const want = toQoderPrompt(kernel);
  const have = fs.existsSync(DST) ? fs.readFileSync(DST, 'utf8') : '';

  if (check || diffOnly) {
    if (want === have) {
      console.log(`ok  qoder prompt matches the kernel (${want.length} chars, ${want.split('\n').length - 1} lines of text)`);
      return 0;
    }
    const d = firstDrift(want.split('\n'), have.split('\n'));
    console.error(`drift  ${path.relative(ROOT, DST)} is not generated from ${path.relative(ROOT, SRC)}`);
    if (d) {
      console.error(`  first difference at line ${d.line}`);
      console.error(`  kernel+strip : ${JSON.stringify(d.kernel)}`);
      console.error(`  qoder (now)  : ${JSON.stringify(d.qoder)}`);
    }
    console.error('  fix: node scripts/sync-qoder-prompt.mjs');
    return 1;
  }

  if (want === have) {
    console.log(`ok  qoder prompt already in sync (${want.length} chars); nothing written`);
    return 0;
  }
  fs.writeFileSync(DST, want, 'utf8');
  console.log(`wrote ${path.relative(ROOT, DST)} (${want.length} chars, ${want.split('\n').length - 1} lines) from ${path.relative(ROOT, SRC)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
