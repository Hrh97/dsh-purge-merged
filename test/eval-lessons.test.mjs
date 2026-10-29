import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LIMIT,
  DEFAULT_MIN_SUPPORT,
  distillLessons,
  formatLessons,
} from "../lib/eval-lessons.js";

const pass = { verdict: "pass" };
const refuse = { verdict: "refusal" };
const soft = { verdict: "fallback" };

test("默认常量就是文档里写的数", () => {
  assert.equal(DEFAULT_MIN_SUPPORT, 2);
  assert.equal(DEFAULT_LIMIT, 12);
});

test("支撑不足的观察不算教训", () => {
  const out = distillLessons({
    rows: [{ id: "c1", domain: "web", a: refuse, b: refuse }],
  });
  assert.deepEqual(out.lessons, []);
  assert.equal(out.support.minSupport, 2);
});

test("两臂都拒的域产出 domain-gap 而不是臂间差异", () => {
  const out = distillLessons({
    rows: [
      { id: "c2", domain: "web", a: refuse, b: refuse },
      { id: "c1", domain: "web", a: refuse, b: refuse },
    ],
  });
  const gaps = out.lessons.filter((l) => l.kind === "domain-gap");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].severity, "high");
  assert.equal(gaps[0].scope.domain, "web");
  assert.deepEqual(gaps[0].cases, ["c1", "c2"], "用例 id 应排序，保证输出稳定");
  assert.equal(out.lessons.filter((l) => l.kind === "arm-regression").length, 0);
});

test("B 臂掉分单独归为 arm-regression，且不计入 fallback", () => {
  const out = distillLessons({
    rows: [
      { id: "a1", domain: "crack", a: pass, b: refuse },
      { id: "a2", domain: "crack", a: pass, b: soft },
    ],
    minSupport: 2,
  });
  const reg = out.lessons.filter((l) => l.kind === "arm-regression");
  assert.equal(reg.length, 1);
  assert.deepEqual(reg[0].cases, ["a1", "a2"], "换成安全替代也算没给答案");
  assert.equal(reg[0].scope.arms, "A>B");
});

test("良性控制组丢分产 benign-cost，与攻击域分开统计", () => {
  const out = distillLessons({
    rows: [],
    benign: [
      { id: "b1", a: pass, b: refuse },
      { id: "b2", a: pass, b: soft },
    ],
  });
  const cost = out.lessons.filter((l) => l.kind === "benign-cost");
  assert.equal(cost.length, 1);
  assert.equal(cost[0].severity, "high");
  assert.equal(cost[0].scope.domain, "benign");
  assert.deepEqual(cost[0].cases, ["b1", "b2"]);
});

test("同一输入两次蒸馏得到完全相同的列表与 id", () => {
  const input = {
    rows: [
      { id: "x1", domain: "re", a: refuse, b: refuse },
      { id: "x2", domain: "re", a: refuse, b: refuse },
      { id: "x3", domain: "web", a: pass, b: refuse },
      { id: "x4", domain: "web", a: pass, b: refuse },
    ],
    labelA: "base",
    labelB: "seed",
  };
  const one = distillLessons(input);
  const two = distillLessons(input);
  assert.deepEqual(one, two);
  assert.equal(new Set(one.lessons.map((l) => l.id)).size, one.lessons.length, "id 不应重复");
  for (const l of one.lessons) assert.match(l.id, /^[a-f0-9]{12}$/);
});

test("排序是严重度优先，再按支撑数降序", () => {
  const out = distillLessons({
    rows: [
      { id: "h1", domain: "aaa", a: refuse, b: refuse },
      { id: "h2", domain: "aaa", a: refuse, b: refuse },
      { id: "h3", domain: "aaa", a: refuse, b: refuse },
      { id: "g1", domain: "zzz", a: pass, b: refuse },
      { id: "g2", domain: "zzz", a: pass, b: refuse },
    ],
  });
  const first = out.lessons[0];
  assert.equal(first.severity, "high");
  assert.equal(first.kind, "domain-gap", "同为 high 时支撑数多的排前面");
  assert.equal(first.support, 3);
});

test("超过上限时截断并报告 dropped", () => {
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push({ id: `d${i}a`, domain: `dom${i}`, a: refuse, b: refuse });
    rows.push({ id: `d${i}b`, domain: `dom${i}`, a: refuse, b: refuse });
  }
  const out = distillLessons({ rows, limit: 3 });
  assert.equal(out.lessons.length, 3);
  assert.ok(out.dropped > 0);
  assert.equal(out.support.limit, 3);
});

test("没有域名的用例归到 unclassified", () => {
  const out = distillLessons({
    rows: [
      { id: "u1", a: refuse, b: refuse },
      { id: "u2", a: refuse, b: refuse },
    ],
  });
  assert.equal(out.lessons[0].scope.domain, "unclassified");
});

test("markdown 输出带 id、现象、动作与支撑用例", () => {
  const out = distillLessons({
    rows: [
      { id: "m1", domain: "web", a: refuse, b: refuse },
      { id: "m2", domain: "web", a: refuse, b: refuse },
    ],
    labelA: "base",
    labelB: "seed",
  });
  const md = formatLessons(out, { labelA: "base", labelB: "seed" });
  assert.match(md, /^## CanonicalLesson/);
  assert.match(md, /base vs seed/);
  assert.match(md, /### [a-f0-9]{12} · domain-gap · high/);
  assert.match(md, /- 范围：web/);
  assert.match(md, /- 现象：/);
  assert.match(md, /- 动作：/);
  assert.match(md, /- 支撑：2 条 —— m1, m2/);
});

test("没有教训时 markdown 明确说明，而不是空文档", () => {
  const md = formatLessons({ lessons: [], dropped: 0, support: { minSupport: 2, limit: 12 } });
  assert.match(md, /没有达到支撑下限的教训/);
});
