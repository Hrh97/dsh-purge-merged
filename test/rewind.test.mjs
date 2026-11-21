// /rewind 当前轮回退的离线契约（v1.2.7，对照 CallMeGuLab 2.0.0）。
//
// 本地 lib/rewind.js 早已实现「按当前轮而非首条 user 回退 + 消息退回输入框 + 已完成任务
// 退出会话」，此处把这条契约钉成测试：planRewind(events, "round") 必须只切最后一轮，
// 不碰上一轮；lastHumanUserText 必须取当前轮那句；draft TTL 与取用语义一并锁定。
//
// 事件流布局遵循 DSH 日志真实顺序：turn/start 在前，user/message 落在该 turn 窗口内
// （seq 更大）——userTextFromRange 从后往前找，seq < cutSeq 即停。
import test from "node:test";
import assert from "node:assert/strict";

import {
  planRewind,
  lastHumanUserText,
  getDraft,
  takeDraft,
  getPending,
} from "../lib/rewind.js";

const user = (seq, text, extra = {}) => ({
  seq, type: "user/message",
  data: { content: [{ type: "text", text }], ...extra },
});

test("planRewind round: 按最后一轮 turn/start 边界切，不动上一轮", () => {
  const events = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    user(2, "第一轮提问"),
    { seq: 3, type: "turn/end", data: { turn: 1 } },
    { seq: 4, type: "turn/start", data: { turn: 2 } },
    user(5, "第二轮提问"),
    { seq: 6, type: "step/start", data: { turn: 2, step: 1 } },
  ];
  const plan = planRewind(events, "round");
  assert.equal(plan.ok, true);
  assert.equal(plan.unit, "turn");
  assert.equal(plan.text, "第二轮提问", "必须退回当前轮那句，不是第一轮");
  assert.equal(plan.fromSeq, 4, "切点必须是最后一轮的 turn/start");
  assert.equal(plan.atSeq, 3, "回退锚点落在上一轮最后一条");
});

test("planRewind round: 已完成的多轮会话切最后一整轮", () => {
  const events = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    user(2, "A"),
    { seq: 3, type: "turn/end", data: { turn: 1 } },
    { seq: 4, type: "turn/start", data: { turn: 2 } },
    user(5, "B"),
    { seq: 6, type: "turn/end", data: { turn: 2 } },
  ];
  const plan = planRewind(events, "round");
  assert.equal(plan.text, "B");
  assert.equal(plan.fromSeq, 4);
});

test("planRewind once: 撤最后一步且同轮首步时退到 turn 边界", () => {
  const events = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    user(2, "提问"),
    { seq: 3, type: "step/start", data: { turn: 1, step: 1 } },
  ];
  const plan = planRewind(events, "once");
  assert.equal(plan.ok, true);
  assert.equal(plan.unit, "step");
  assert.equal(plan.fromSeq, 1, "同轮首步退到 turn/start");
  assert.equal(plan.text, "提问");
});

test("planRewind: 空事件返回 Nothing to undo", () => {
  const plan = planRewind([], "round");
  assert.equal(plan.ok, false);
  assert.match(plan.error, /Nothing to undo/);
});

test("planRewind: 忽略 plugin 来源与 rewind marker，不把它们当当前轮提示", () => {
  const events = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    user(2, "真实提问"),
    user(3, "[MNEMON] 插件草稿", { source: { kind: "plugin" } }),
    { seq: 4, type: "user/message", data: { id: "rewind-marker-1", content: "marker" } },
  ];
  const plan = planRewind(events, "round");
  assert.equal(plan.text, "真实提问");
});

test("lastHumanUserText: 取最近一条真人消息，跳过插件草稿", () => {
  const events = [
    user(1, "第一句"),
    user(2, "[MNEMON RUNTIME MEMORY SNAPSHOT]", { source: { kind: "plugin" } }),
    user(3, "最近一句"),
  ];
  assert.equal(lastHumanUserText(events), "最近一句");
});

test("draft: 未写入时 get/take/getPending 均为 null", () => {
  assert.equal(getDraft("no-such-session"), null);
  assert.equal(takeDraft("no-such-session"), null);
  assert.equal(getPending(), null);
  assert.equal(getDraft("no-such-session"), null);
});
