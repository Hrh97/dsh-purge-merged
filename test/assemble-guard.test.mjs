// assembleGuard 组装失败不丢工具 schema 回归。
//
// 背景（ZXEB/dsh-purge v1.1.75，2026-11-16）：原生 assemble 抛异常时，如果本槽
// 还没有 lastGood（首次装配就失败），旧兜底返回 { sections:[], contexts:[], tools:[] }。
// 模型拿不到任何工具 schema，就把工具调用写成正文（DSML），表象是「模型不会调工具」，
// 真因是兜底吞了 schema。
//
// 本地约束：不能直接 throw err —— identity.js 的注释明确记着 throw 会让下游
// sections.map 崩、UI 出现「任务到一半就苏醒」。折中 = 记住全进程最近一次成功
// 装配里的 tools，首次失败时用它兜底；同进程内工具 schema 由宿主决定、稳定。
import test from "node:test";
import assert from "node:assert/strict";

import { assembleFailureFallback, installAssembleGuard } from "../lib/identity.js";

const TOOL = { type: "function", function: { name: "bash", parameters: {} } };
const GOOD = { sections: [{ text: "sys" }], contexts: [], tools: [TOOL] };
const passthrough = (a) => a;

test("纯函数：lastGood 带 tools 时优先原样保留", () => {
  const out = assembleFailureFallback({ lastGood: GOOD }, new Error("x"), [{ name: "other" }]);
  assert.equal(out, GOOD, "有完整 lastGood 时直接复用，不造新对象");
  assert.deepEqual(out.tools, [TOOL]);
});

test("纯函数：lastGood 为空但进程有最近成功 tools → 补回 tools", () => {
  const out = assembleFailureFallback({ lastGood: null }, new Error("x"), [TOOL]);
  assert.deepEqual(out.tools, [TOOL]);
  assert.deepEqual(out.sections, []);
  assert.deepEqual(out.contexts, []);
});

test("纯函数：lastGood 存在但 tools 空 → 用进程 recent tools 兜底，其余保留", () => {
  const good = { sections: [{ text: "sys" }], contexts: ["ctx"], tools: [] };
  const out = assembleFailureFallback({ lastGood: good }, new Error("x"), [TOOL]);
  assert.deepEqual(out.tools, [TOOL], "工具补回");
  assert.deepEqual(out.sections, good.sections, "段落不丢");
  assert.deepEqual(out.contexts, good.contexts, "上下文不丢");
  assert.notEqual(out, good, "不要原地改 lastGood");
  assert.deepEqual(good.tools, [], "原对象未被改写");
});

test("纯函数：没有任何可用 tools 时不 inject 假工具，也不抛", () => {
  const out = assembleFailureFallback({ lastGood: null }, new Error("x"), null);
  assert.deepEqual(out.tools, []);
  assert.deepEqual(out.sections, []);
  assert.deepEqual(out.contexts, []);
});

test("集成：先成功装配一次，再让另一 prompt 首调抛错 → 不抛且保留 tools", async () => {
  // 第一次成功装配会把工具 schema 记进进程级缓存。
  const okPrompt = { assemble: async () => GOOD };
  installAssembleGuard(okPrompt, passthrough);
  const first = await okPrompt.assemble();
  assert.deepEqual(first.tools, [TOOL]);

  // 第二个 prompt 首调就抛（模拟 unknown prompt variable）。
  let calls = 0;
  const badPrompt = {
    assemble: async () => {
      calls += 1;
      throw new Error('unknown prompt variable "{{cwd}}"');
    },
  };
  installAssembleGuard(badPrompt, passthrough);
  const fallback = await badPrompt.assemble();
  assert.equal(calls, 1, "确实走了抛错分支");
  assert.deepEqual(fallback.tools, [TOOL], "关键断言：工具 schema 没被吞成空数组");
});
