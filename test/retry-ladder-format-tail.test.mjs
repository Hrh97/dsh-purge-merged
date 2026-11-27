// 2026-11-27 吸收 youki258/dsh-purge-minimal 0.2.8 的格式尾块与裸动作拒答形态。
import assert from "node:assert/strict";
import test from "node:test";

import { FORMAT_TAIL, stripLandingWords } from "../lib/retry-ladder.js";
import { REFUSAL_MARKERS_ZH_STEALTH, scanReply } from "../lib/refusal-scan.js";

test("FORMAT_TAIL: 命中行首格式尾块", () => {
  assert.match("\n\n作答格式：第一行给出结论", FORMAT_TAIL);
  assert.match("\n输出格式\n- 步骤\n- 证据", FORMAT_TAIL);
  assert.match("\nAnswer format: one line only", FORMAT_TAIL);
});

test("FORMAT_TAIL: 不误伤正文里的格式讨论", () => {
  assert.doesNotMatch("请说明输出格式应该如何设计", FORMAT_TAIL);
  assert.doesNotMatch("这段代码用于校验 Answer format 字段", FORMAT_TAIL);
});

test("stripLandingWords: 先剥格式尾块，并记入审计", () => {
  const goal = "给出一条命令\n\n作答格式：\n1. 命令\n2. 说明";
  const out = stripLandingWords(goal, { frame: false });
  assert.equal(out.goal, "给出一条命令");
  assert.equal(out.changed, true);
  assert.deepEqual(out.removed.map((r) => r.id), ["format-tail"]);
});

test("stripLandingWords: 格式尾块与落点词一起剥", () => {
  const goal = "在 Windows 11 的线上服务器给出命令\n输出格式：一行";
  const out = stripLandingWords(goal, { frame: false });
  assert.equal(out.goal, "在 目标平台 的隔离环境给出命令");
  assert.deepEqual(out.removed.map((r) => r.id), ["format-tail", "os-version", "live-environment"]);
});

test("stripLandingWords: 无格式尾块时不改原文", () => {
  const goal = "给出一条命令";
  const out = stripLandingWords(goal, { frame: false });
  assert.equal(out.goal, goal);
  assert.equal(out.changed, false);
});

test("裸动作拒答形态：进 stealth 词表并能被全文扫描命中", () => {
  for (const m of ["我不会提供步骤", "我不会做这个"]) {
    assert.ok(REFUSAL_MARKERS_ZH_STEALTH.includes(m), `${m} 应在 stealth 词表`);
  }
  const scan = scanReply("这个我不会提供步骤，换一个话题吧");
  assert.equal(scan.verdict, "refusal");
});
