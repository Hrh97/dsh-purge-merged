// 锚点医生（吸收自 kingcharleslzy-ai/dsh-purge Community 的 diagnose/reanchor 思路）。
//
// 上游宿主一发版，我们补丁里的 pattern（锚点）就可能对不上 —— 轻则整条补丁
// pending，重则漂移到没人注意的角落。这组测试钉死三件事：
//   1. locateCandidate 能在「锚点还在」与「只差半行」两种情形下给出正确答案；
//   2. 锚点覆盖（overrides）能安全替换 pattern：from 对不上必须按 stale 丢弃，
//      绝不把错误的锚硬塞给补丁；
//   3. 诊断器对假宿主树（注入 files 映射）能数对 applied/pending/drifted。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ANCHOR_STATE_FILE,
  anchorStatePath,
  fingerprintOf,
  loadAnchorOverrides,
  saveAnchorOverrides,
  applyAnchorOverrides,
  locateCandidate,
  diagnosePatches,
  formatDiagnosis,
  reanchorPatch,
} from "../lib/anchor-doctor.js";

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-anchors-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DRIFT_SRC = [
  "function setup() {",
  "  const bar = baz.qux();",
  "  return bar;",
  "}",
  "",
].join("\n");

const OLD_PATTERN = [
  "const bar = baz.qux();",
  "  return bar;",
  "}",
].join("\n");

test("locateCandidate: 原文完全在 → exact", () => {
  const r = locateCandidate(DRIFT_SRC, OLD_PATTERN);
  assert.ok(r.exact === true);
  assert.equal(r.fragment, OLD_PATTERN);
});

test("locateCandidate: 锚点漂移半行 → 给出候选行和行号", () => {
  const drifted = DRIFT_SRC.replace("const bar = baz.qux();", "const bar = baz.quux();");
  const r = locateCandidate(drifted, OLD_PATTERN);
  assert.ok(r, "应能定位");
  assert.equal(r.exact, false);
  assert.equal(r.line, 2);
  assert.match(r.candidateLine, /baz\.quux\(\)/);
  assert.ok(!r.candidateLine.includes("\n"), "候选行是单行");
});

test("locateCandidate: 语义大改找不到 → null 而不是硬猜", () => {
  const gone = "function setup() {\n  return null;\n}\n";
  assert.equal(locateCandidate(gone, OLD_PATTERN), null);
});

test("fingerprintOf: 压空白后截前 24 字符，同一锚点不同缩进同指纹", () => {
  const a = fingerprintOf("const x = 1;\n  doThing();");
  const b = fingerprintOf("const x = 1;   doThing();");
  assert.equal(a, b);
  assert.ok(a.length <= 24);
});

test("applyAnchorOverrides: from 匹配才替换，不匹配进 stale", () => {
  const patches = [
    { id: 42, replacements: [{ pattern: "AAA", replace: "R1" }, { pattern: "CCC", replace: "R2" }] },
  ];
  const overrides = { 42: { 0: { from: "AAA", to: "BBB" }, 1: { from: "WRONG", to: "X" } } };
  const out = applyAnchorOverrides(patches, overrides);
  assert.deepEqual(out.applied, [{ id: 42, pi: 0 }]);
  assert.deepEqual(out.stale, [{ id: 42, pi: 1 }]);
  assert.equal(out.patches[0].replacements[0].pattern, "BBB");
  assert.equal(out.patches[0].replacements[1].pattern, "CCC", "stale 的保持原样");
});

test("applyAnchorOverrides: 无覆盖的补丁原样透传（不克隆）", () => {
  const p = { id: 7, replacements: [{ pattern: "A", replace: "B" }] };
  const out = applyAnchorOverrides([p], {});
  assert.equal(out.patches[0], p, "同一引用，未克隆");
});

test("overrides 往返：save → load 拿回同一份", async (t) => {
  const home = tmpHome(t);
  await saveAnchorOverrides({ 42: { 0: { from: "AAA", to: "BBB", note: "x" } } }, home, "test");
  const { overrides } = loadAnchorOverrides(home);
  assert.deepEqual(overrides["42"]["0"].to, "BBB");
  assert.equal(fs.existsSync(anchorStatePath(home)), true);
  assert.ok(anchorStatePath(home).endsWith(ANCHOR_STATE_FILE));
});

test("diagnosePatches: 假宿主树数数正确（注入 files 映射）", async (t) => {
  const home = tmpHome(t);
  // 产物行必须 ≥12 字符（lib 的 hasResult 阈值，防短行误判），所以 replace 全用长名。
  const appliedSrc = "AAA_OUT_EXTENDED\nfooter\n";
  const pendingSrc = "AAA\nfooter\n";
  const driftedSrc = "nothing here\n";
  const files = new Map();
  files.set(1, path.join(home, "a.js"));
  fs.writeFileSync(files.get(1), appliedSrc, "utf8");
  files.set(2, path.join(home, "b.js"));
  fs.writeFileSync(files.get(2), pendingSrc, "utf8");
  files.set(3, path.join(home, "c.js"));
  fs.writeFileSync(files.get(3), driftedSrc, "utf8");
  const patches = [
    { id: 1, file: 1, name: "applied-one", replacements: [{ pattern: "AAA", replace: "AAA_OUT_EXTENDED" }] },
    { id: 2, file: 2, name: "pending-one", replacements: [{ pattern: "AAA", replace: "BBB_OUT_PENDING" }] },
    { id: 3, file: 3, name: "drifted-one", replacements: [{ pattern: "AAA", replace: "CCC_OUT_DRIFTED" }] },
    { id: 4, file: 4, name: "missing-one", replacements: [{ pattern: "AAA", replace: "DDD_OUT_MISSING" }] },
  ];
  // files 映射按补丁 file 键取；这里用自定义解析：file 键是数字 —— 为此
  // diagnosePatches 支持 options.files 直接传 Map<patch.file, path>。
  const keyed = new Map([
    [1, files.get(1)],
    [2, files.get(2)],
    [3, files.get(3)],
    // 4 故意不给 → missing_file
  ]);
  const rep = await diagnosePatches(null, patches, { dshHome: home, files: keyed });
  assert.equal(rep.counts.applied, 1);
  assert.equal(rep.counts.pending, 1);
  assert.equal(rep.counts.drifted, 1);
  assert.equal(rep.counts.missing_file, 1);
  assert.ok(rep.drifted[0].id === 3);
  const text = formatDiagnosis(rep);
  assert.match(text, /applied.*1/);
});

test("reanchorPatch: 候选行不唯一 → 拒绝盲钉", async (t) => {
  const home = tmpHome(t);
  const fp = path.join(home, "dup.js");
  fs.writeFileSync(fp, "const bar = baz.quux();\nconst bar = baz.quux();\n", "utf8");
  const patches = [{ id: 77, file: 77, replacements: [{ pattern: OLD_PATTERN, replace: "X_OUT" }] }];
  await assert.rejects(
    () => reanchorPatch(77, 0, { dshHome: home, aiBase: null, files: new Map([[77, fp]]), patches }),
    /不唯一|拒绝/,
  );
});
