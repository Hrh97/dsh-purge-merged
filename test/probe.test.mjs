// 运行时探针（吸收自 kingcharleslzy-ai/dsh-purge Community 的 probe 思路）。
//
// 探针 = 往注入文件尾部装一个带唯一 token 的小块，然后跟 dsh 对话让它复述
// 那一行——答得出就证明「写进文件 → 模型真的看到」整条链路是通的。
// 这些测试钉死纯函数层的正确性（token 生成/块往返/剥离），以及 arm/clear/
// status 在一个临时 dshHome 里的完整生命周期。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROBE_BEGIN,
  PROBE_END,
  PROBE_STATE_FILE,
  probeStatePath,
  makeProbeToken,
  probeBlock,
  findProbeToken,
  stripProbeBlock,
  armProbe,
  clearProbe,
  probeStatus,
} from "../lib/probe.js";
import * as core from "../lib/core.js";

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("makeProbeToken: DSPROBE- + 8 位 hex，且随机", () => {
  const a = makeProbeToken();
  const b = makeProbeToken();
  assert.match(a, /^DSPROBE-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test("probeBlock 往返：findProbeToken 在前后有内容时也能找到", () => {
  const t1 = makeProbeToken();
  const blk = probeBlock(t1);
  assert.ok(blk.startsWith("\n" + PROBE_BEGIN));
  assert.ok(blk.endsWith(PROBE_END + "\n"));
  assert.equal(findProbeToken(blk), t1);
  assert.equal(findProbeToken("before\n" + blk + "after"), t1);
});

test("findProbeToken: 格式坏了返回 null（不宽容）", () => {
  assert.equal(findProbeToken("- probe: DSPROBE-1234567"), null, "7 位不行");
  assert.equal(findProbeToken("- probe: DSPROBE-12345678"), null, "没块标记不行");
  assert.equal(findProbeToken(""), null);
});

test("stripProbeBlock: 剥掉块，前后内容无损", () => {
  const t1 = makeProbeToken();
  const doc = "head\n" + probeBlock(t1) + "tail";
  assert.equal(stripProbeBlock(doc), "head\ntail");
  assert.equal(stripProbeBlock("no block here"), "no block here");
});

test("armProbe: 没有注入文件时抛错（提示先 --apply）", async (t) => {
  const home = tmpHome(t);
  await assert.rejects(() => armProbe(home), /先跑 --apply|注入文件/);
});

test("armProbe → probeStatus 活跃 → clearProbe 收干净（真 core 函数全生命周期）", async (t) => {
  const home = tmpHome(t);
  const inject = path.join(home, "prompt-inject.md");
  fs.writeFileSync(inject, "我的长期规则正文。\n", "utf8");
  // core.saveOverrideContent 真函数就是写 <dshHome>/prompt-inject.md，直接用，不 monkey patch（ESM namespace 只读）。

  const st = await armProbe(home);
  assert.match(st.token, /^DSPROBE-[0-9a-f]{8}$/);
  const after = fs.readFileSync(inject, "utf8");
  assert.ok(after.startsWith("我的长期规则正文。"), "原正文保留");
  assert.equal(findProbeToken(after), st.token);
  assert.ok(fs.existsSync(probeStatePath(home)));
  assert.equal(fs.existsSync(path.join(home, PROBE_STATE_FILE)), true);

  const status = probeStatus(home);
  assert.equal(status.active, true);
  assert.equal(status.state.token, st.token);
  assert.equal(status.live, st.token);

  // 再 arm 一次：旧块被替换，不叠罗汉
  const st2 = await armProbe(home);
  assert.notEqual(st2.token, st.token);
  const after2 = fs.readFileSync(inject, "utf8");
  assert.equal((after2.match(new RegExp(PROBE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  assert.equal(findProbeToken(after2), st2.token);

  const cleared = await clearProbe(home);
  assert.equal(cleared.cleared, true);
  assert.equal(stripProbeBlock(fs.readFileSync(inject, "utf8")), fs.readFileSync(inject, "utf8"));
  assert.equal(fs.existsSync(probeStatePath(home)), false);
  assert.equal(probeStatus(home).active, false);
});

test("clearProbe: 本来就没有探针 → cleared:false 且不报错", async (t) => {
  const home = tmpHome(t);
  fs.writeFileSync(path.join(home, "prompt-inject.md"), "plain\n", "utf8");
  const r = await clearProbe(home);
  assert.equal(r.cleared, false);
});
