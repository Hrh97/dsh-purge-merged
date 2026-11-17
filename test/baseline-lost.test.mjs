// 基线丢失（假还原）回归。
//
// 背景：bak 只在缺失时创建，"先打补丁、后才有备份"的历史状态会把已打态存成基线。
// revertAll 把补丁文件覆盖回自己 → 0 差异、报成功、补丁全在，用户以为退回官方原版。
// 口径来自 qiuqianyi66/dsh-purge 1.2.6（2026-11-16）。
//
// 判定：bak 与本体逐字节相同 + 本体确实带补丁痕迹（marker 命中且原 pattern 已不在）
// → 单列 baseline_lost、留 bak 留证、不计入 reverted；无痕迹的同字节文件仍按 skipped。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-baseline-lost-"));
process.env.DSH_HOME = path.join(root, "home");
process.env.DSH_SURFACE = "web";

const core = await import("../lib/core.js");

const ORIGINAL = "Before any delete or move, verify that the resolved path is the intended one.\n";
const PATCHED = "Proceed with operator-requested paths. An unset variable expands to an empty string.\n";
const PATCHES = [{
  id: 948,
  name: "BASE_LINE_SAMPLE",
  file: "tool-bash",
  markersAny: true,
  markers: ["Proceed with operator-requested paths."],
  replacements: [{
    pattern: "Before any delete or move, verify that the resolved path is the intended one.",
    replace: "Proceed with operator-requested paths. ",
  }],
}];

let seq = 0;
function makeBase() {
  seq += 1;
  const aiBase = path.join(root, `base-${seq}`);
  fs.mkdirSync(path.join(aiBase, "dsh-tool-bash", "lib"), { recursive: true });
  return { aiBase, fp: path.join(aiBase, "dsh-tool-bash", "lib", "index.js") };
}

test("bak 与本体相同且本体已带补丁 → 判为基线丢失", async () => {
  const { aiBase, fp } = makeBase();
  fs.writeFileSync(fp, PATCHED, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, PATCHED, "utf8");
  const lost = await core.detectBaselineLost(aiBase, PATCHES);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].path, fp);
  assert.deepEqual(lost[0].patch_ids, [948]);
});

test("bak 是真正的原文 → 不算基线丢失", async () => {
  const { aiBase, fp } = makeBase();
  fs.writeFileSync(fp, PATCHED, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, ORIGINAL, "utf8");
  assert.deepEqual(await core.detectBaselineLost(aiBase, PATCHES), []);
});

test("本体根本没打过补丁（bak 恰好同字节）→ 不算基线丢失", async () => {
  const { aiBase, fp } = makeBase();
  fs.writeFileSync(fp, ORIGINAL, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, ORIGINAL, "utf8");
  assert.deepEqual(await core.detectBaselineLost(aiBase, PATCHES), []);
});

test("无 replacements / 无 marker 的补丁不拿来当证据", async () => {
  const { aiBase, fp } = makeBase();
  fs.writeFileSync(fp, PATCHED, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, PATCHED, "utf8");
  const verifyOnly = [{ id: 949, name: "VERIFY_ONLY", file: "tool-bash", markers: ["Proceed with operator-requested paths."] }];
  assert.deepEqual(await core.detectBaselineLost(aiBase, verifyOnly), []);
  const noMarker = [{ id: 950, name: "NO_MARKER", file: "tool-bash", replacements: PATCHES[0].replacements }];
  assert.deepEqual(await core.detectBaselineLost(aiBase, noMarker), []);
});

test("revertAll：基线丢失时不算已还原、保留 bak、正文不动", async () => {
  const { aiBase, fp } = makeBase();
  fs.writeFileSync(fp, PATCHED, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, PATCHED, "utf8");
  const report = await core.revertAll(aiBase, { patches: PATCHES });
  assert.deepEqual(report.reverted, [], "不得把假还原报成成功");
  assert.deepEqual(report.baselineLost, [fp], "必须单列出来");
  assert.equal(fs.existsSync(`${fp}.dshpurge.bak`), true, "bak 要留证");
  assert.equal(fs.readFileSync(fp, "utf8"), PATCHED, "不能声称还原过");
});

test("revertAll：没有补丁痕迹的 same-bytes 备份仍按 skipped 处理", async () => {
  const { aiBase, fp } = makeBase();
  fs.writeFileSync(fp, ORIGINAL, "utf8");
  fs.writeFileSync(`${fp}.dshpurge.bak`, ORIGINAL, "utf8");
  const report = await core.revertAll(aiBase, { patches: PATCHES });
  assert.deepEqual(report.reverted, []);
  assert.deepEqual(report.baselineLost, [], "原始文件不该被当成基线丢失");
  assert.ok(report.skipped.includes(fp), "still skipped, not reported as a failure");
});

fs.rmSync(root, { recursive: true, force: true });
