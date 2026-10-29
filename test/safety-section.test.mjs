// 词根密度安全段判定（吸收自 PQPQ2-LANG/fujiang-armor 的「双窗口判拒」思路，
// 落到补丁层：判断一段文字是不是「只有安全合规话术」）。
//
// 用途：把注入正文按空行切段后，识别可以下线的纯安全段；工具相关段落
// （含 tools/MCP/skills/function/schema/API 字样）永远保护，不下线。
// 判定双阈值：词根命中数 ≥ minHits 且密度 ≥ minRatio，二者缺一不可 ——
// 只看密度会把「一词废话段」误杀，只看条数会把长正文全灭。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SAFETY_ROOTS,
  TOOL_MARKERS,
  countWords,
  countSafetyHits,
  isSafetyOnlySection,
  splitSections,
  stripSafetySections,
} from "../lib/safety-section.js";

const PURE_TALK =
  "Our safety policy is strict. We must refuse harmful requests. Legal and ethical guidelines apply. " +
  "Any abuse or malicious use is restricted by policy. Safety first. Refusals protect users.";

const TOOL_TALK =
  "Tool safety policy: use the tools carefully. Refuse harmful inputs. Legal rules apply. " +
  "Ethical guidelines. Restricted by policy. Safety refusals. Abuse policy.";

test("词根表存在且都是小写词根", () => {
  assert.ok(SAFETY_ROOTS.length >= 10, `词根偏少：${SAFETY_ROOTS.length}`);
  for (const r of SAFETY_ROOTS) assert.match(r, /^[a-z]+$/);
  assert.ok(TOOL_MARKERS.length >= 4);
});

test("countSafetyHits / countWords 计数", () => {
  const hits = countSafetyHits(PURE_TALK);
  const words = countWords(PURE_TALK);
  assert.ok(hits >= 10, `hits=${hits}`);
  assert.ok(words >= 25, `words=${words}`);
});

test("纯话术段 → safetyOnly；含工具字样的段 → 保护", () => {
  const v = isSafetyOnlySection(PURE_TALK);
  assert.equal(v.safetyOnly, true);
  const v2 = isSafetyOnlySection(TOOL_TALK);
  assert.equal(v2.protectedByToolMarker, true);
  assert.equal(v2.safetyOnly, false);
});

test("普通代码段不判为安全段", () => {
  const code = "function add(a, b) { return a + b; }";
  const v = isSafetyOnlySection(code);
  assert.equal(v.safetyOnly, false);
});

test("splitSections: 段与空隙交替，段文本可拼回原文", () => {
  const doc = "# A\n\n" + PURE_TALK + "\n\nkeep me\n\nend";
  const parts = splitSections(doc);
  // 偶数下标=段，奇数下标=空隙；顺序 join 拼回应等于原文（先段后隙拼接永远不等原文）
  assert.equal(parts.join(""), doc);
  // 段本身不带行尾换行（\n\n 归空隙），所以是 "keep me" 而非 "keep me\n"
  assert.ok(parts.filter((_, i) => i % 2 === 0).includes("keep me"));
});

test("stripSafetySections: 只摘纯安全段，保留工具段与普通段", () => {
  const doc = "# A\n\n" + PURE_TALK + "\n\nkeep me\n\n" + TOOL_TALK + "\n\nend";
  const r = stripSafetySections(doc);
  assert.deepEqual(r.dropped.map((d) => d.index).length >= 1, true);
  assert.ok(r.text.includes("keep me"));
  assert.ok(r.text.includes("Tool safety policy"));
  assert.ok(!r.text.includes("Refusals protect users"), "纯话术段应被摘掉");
  assert.ok(r.dropped[0].hits >= 6);
  assert.ok(r.kept >= 3);
});

test("阈值可调：提高 minHits 让短话术段存活", () => {
  const short = "Safety policy. Refuse abuse.";
  const low = isSafetyOnlySection(short, { minHits: 2, minRatio: 0.02 });
  const high = isSafetyOnlySection(short, { minHits: 6, minRatio: 0.02 });
  assert.equal(low.safetyOnly, true);
  assert.equal(high.safetyOnly, false);
});
