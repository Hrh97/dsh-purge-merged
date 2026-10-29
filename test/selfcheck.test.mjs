// 一屏自检（吸收自 kingcharleslzy-ai/dsh-purge Community 的 selfcheck 层思路）。
//
// runSelfcheck 把「插件现在到底接没接好」压成 7 行。这里用假 state + 临时
// dshHome 钉死每行的判定：注入文件三态（没有/出厂默认/已清洗）、备份缺失
// 告警、symlink 断链告警、shim 两缺告警，以及 anchors/probe/qoder 三条
// 信息项永远 ok（只有状态没有好坏）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSelfcheck, formatSelfcheck } from "../lib/selfcheck.js";

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-selfcheck-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("没有注入文件 → inject 行 warn；备份/symlink/shim 缺 → 对应 warn", async (t) => {
  const home = tmpHome(t);
  const sc = await runSelfcheck({ state: {}, dshHome: home, repoRoot: home });
  const byKey = Object.fromEntries(sc.rows.map((r) => [r.key, r]));
  assert.equal(byKey.inject.warn, true);
  assert.match(byKey.inject.detail, /不存在/);
  assert.equal(byKey.backup.warn, true, "无备份要告警");
  assert.match(byKey.backup.detail, /--revert/);
  assert.equal(byKey.symlink.warn, true);
  assert.match(byKey.symlink.detail, /缺失/);
  assert.ok(sc.warnCount >= 3);
});

test("出厂默认未清洗 → 标记计数告警；已清洗 → ok", async (t) => {
  const home = tmpHome(t);
  fs.writeFileSync(
    path.join(home, "prompt-inject.md"),
    "正文。\n<|im_start|>system:\n<project_instructions>\n",
    "utf8",
  );
  const sc1 = await runSelfcheck({ state: {}, dshHome: home, repoRoot: home });
  const r1 = sc1.rows.find((r) => r.key === "inject");
  assert.equal(r1.warn, true);
  assert.match(r1.detail, /标记 2\/3/);

  fs.writeFileSync(path.join(home, "prompt-inject.md"), "已清洗的托管正文。\n", "utf8");
  const sc2 = await runSelfcheck({ state: {}, dshHome: home, repoRoot: home });
  const r2 = sc2.rows.find((r) => r.key === "inject");
  assert.equal(r2.ok, true);
  assert.match(r2.detail, /已清洗/);
});

test("state.has_backup=true 时不告警；shim 只缺 1 个不告警", async (t) => {
  const home = tmpHome(t);
  fs.writeFileSync(path.join(home, "prompt-inject.md"), "clean\n", "utf8");
  const sc = await runSelfcheck({
    state: { has_backup: true, shim_cmd: "patched", shim_ps1: "missing", shim_bin: "already_patched" },
    dshHome: home,
    repoRoot: home,
  });
  const byKey = Object.fromEntries(sc.rows.map((r) => [r.key, r]));
  assert.equal(byKey.backup.warn, false);
  assert.equal(byKey.backup.detail, ".dshpurge.bak 在");
  assert.equal(byKey.shim.warn, false, "只缺 1 个 shim 不算失联");
  assert.match(byKey.shim.detail, /dsh\.ps1=missing/);
});

test("anchors/probe/qoder 三条信息项永远 ok", async (t) => {
  const home = tmpHome(t);
  const sc = await runSelfcheck({ state: {}, dshHome: home, repoRoot: home });
  for (const key of ["anchors", "probe", "qoder"]) {
    const r = sc.rows.find((r) => r.key === key);
    assert.equal(r.warn, false, `${key} 应是信息项`);
    assert.equal(r.ok, true);
  }
  const q = sc.rows.find((r) => r.key === "qoder");
  assert.ok(/未检测到|^\d/.test(q.detail), `qoder detail 意外：${q.detail}`);
});

test("symlink 指向 repoRoot → ok", async (t) => {
  const home = tmpHome(t);
  const target = tmpHome(t);
  const linkDir = path.join(home, "profiles", "desktop", "node_modules");
  fs.mkdirSync(linkDir, { recursive: true });
  try {
    fs.symlinkSync(target, path.join(linkDir, "dsh-purge"), "junction");
  } catch {
    // 某些环境不允许 junction —— 跳过此用例
    return;
  }
  const sc = await runSelfcheck({ state: {}, dshHome: home, repoRoot: target });
  const r = sc.rows.find((r) => r.key === "symlink");
  assert.equal(r.warn, false);
  assert.match(r.detail, /→/);
});

test("formatSelfcheck: 每行带 ⚠/✓，warnCount 尾行", async () => {
  const text = formatSelfcheck({
    rows: [
      { key: "a", ok: true, warn: false, label: "好的", detail: "x" },
      { key: "b", ok: false, warn: true, label: "坏的", detail: "y" },
    ],
    warnCount: 1,
  });
  assert.match(text, /^自检 \/ selfcheck/);
  assert.match(text, /✓ 好的 — x/);
  assert.match(text, /⚠ 坏的 — y/);
  assert.match(text, /1 项需要关注/);
});
