// 用真实 prompt bank 固定叶子路由的召回率。
//
// 这些 jsonl 是从 maodie-purge v2.0.0 的 tests/ 原样复制过来的（见同目录
// PROVENANCE.md），它的价值不在「越狱」而在「用例是别人写、不是我们自己编的」：
// 110 条覆盖 web / game / llm / crack / re / mobile / network / cloud /
// miniprogram / postex / generic 十一域，中英双语，长短混杂。
//
// 断言只针对攻击域：这些用例必须命中至少一片叶子。原版 dsh-purge 的词表在这里
// 漏 8 条（web 24/27、llm 15/18、crack 7/8、re 6/7），补词后为 0 漏判；这个测试
// 就是把「0 漏判」钉住，防止以后改词表悄悄退回去。
//
// 非攻击域（domain 为空或 plain）不断言必须命中 —— 那条路径的正确行为是
// fail-open 到全文，测试它「必须不命中」等于奖励误判。
import test from "node:test";
import assert from "node:assert/strict";

import { loadAllBanks } from "../lib/prompt-bank.js";
import { pickLeaves } from "../lib/leaf-inject.js";

/** 攻击域：这些用例的正文必须路由到叶子，否则等于按需注入退化成全文注入。 */
const ATTACK_DOMAINS = new Set([
  "web", "game", "llm", "crack", "re", "mobile",
  "network", "cloud", "miniprogram", "postex", "generic",
]);

const { rows, bad, banks } = loadAllBanks();

test("prompt bank: 四个文件都能解析，没有坏行", () => {
  assert.equal(banks.length, 4, `实际载入 ${banks.length} 个 bank`);
  assert.equal(bad.length, 0, `坏行: ${JSON.stringify(bad.slice(0, 3))}`);
  assert.equal(rows.length, 110);
});

test("prompt bank: 每条用例都带正文和域标签", () => {
  for (const row of rows) {
    assert.ok(row.prompt.length > 0, `空 prompt: ${row.id}`);
    assert.ok(row.id.length > 0, "缺 id");
  }
});

test("prompt bank: 攻击域用例 100% 路由到叶子", () => {
  const misses = [];
  let total = 0;
  for (const row of rows) {
    if (!ATTACK_DOMAINS.has(row.domain)) continue;
    total += 1;
    if (pickLeaves(row.prompt).size === 0) misses.push(`${row.id} [${row.domain}] ${row.prompt.slice(0, 60)}`);
  }
  assert.equal(misses.length, 0, `${misses.length}/${total} 条漏判:\n${misses.join("\n")}`);
  // 110 条里 93 条带攻击域标签，其余 17 条是无域标签的对照样本（走 fail-open）。
  assert.equal(total, 93, `攻击域用例应为 93 条，实际 ${total} 条`);
});

test("prompt bank: 每条用例的路由结果稳定（同输入两次同结果）", () => {
  for (const row of rows) {
    const a = [...pickLeaves(row.prompt)].sort();
    const b = [...pickLeaves(row.prompt)].sort();
    assert.deepEqual(a, b, `不稳定: ${row.id}`);
  }
});

test("prompt bank: 空正文不命中任何叶子", () => {
  assert.equal(pickLeaves("").size, 0);
  assert.equal(pickLeaves("   \n  ").size, 0);
});
