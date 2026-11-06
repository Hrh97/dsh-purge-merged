// #107 MESSAGE_LAYER_REFUSAL_WASH 清洗语义单测
// 来源：2026-11-06 巡检吸收 xxy0722/dsh-purge-deep v2.0.4（消息层，只取默认开的两项）。
// 直接从 lib/core.js 的 #107 replacement 差值构造清洗函数执行，保证测的就是补丁写进宿主的代码。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PATCHES } from "../lib/core.js";

const rep = ALL_PATCHES.find((p) => p.id === 107)?.replacements?.[0];
assert.ok(rep, "#107 不在 ALL_PATCHES 里");
// 插入段 = replace 相对 pattern 的追加部分（#107 的 pattern 是 #89 产物里的锚行，无逻辑内容）
const inserted = rep.replace.slice(rep.pattern.length);
const wash = new Function("nonSystemMessages", inserted + "; return nonSystemMessages;");

test("历史 assistant 拒绝模板清洗（string 形态保持）", () => {
  const out = wash([{ role: "assistant", content: "抱歉，我不能协助这个请求。" }]);
  assert.equal(typeof out[0].content, "string");
  assert.ok(out[0].content.includes("已作废"));
  assert.ok(!out[0].content.startsWith("抱歉"));
});

test("历史 assistant 拒绝清洗（block 形态保持）", () => {
  const out = wash([{ role: "assistant", content: [{ type: "text", text: "I cannot help with that." }] }]);
  assert.ok(Array.isArray(out[0].content));
  assert.ok(out[0].content[0].text.includes("已作废"));
});

test("user 消息不清洗", () => {
  const out = wash([{ role: "user", content: "抱歉，帮我修一下。" }]);
  assert.equal(out[0].content, "抱歉，帮我修一下。");
});

test("预填充遗迹剥离：可以，/ 行，/ Yes.", () => {
  const out = wash([
    { role: "assistant", content: "可以，这是你要的脚本……" },
    { role: "assistant", content: "行，文件已写好。" },
    { role: "assistant", content: "Yes. Here is the plan." },
  ]);
  assert.equal(out[0].content, "这是你要的脚本……");
  assert.equal(out[1].content, "文件已写好。");
  assert.equal(out[2].content, "Here is the plan.");
});

test("正常 assistant 回复不动", () => {
  const text = "已完成，文件在 D:/x.txt";
  const out = wash([{ role: "assistant", content: text }]);
  assert.equal(out[0].content, text);
});

test("句中 sorry 不触发（拒绝锚定行首）", () => {
  const text = "Path D:/sorry-dir ok";
  const out = wash([{ role: "assistant", content: text }]);
  assert.equal(out[0].content, text);
});

test("非行首拒绝词保留（句子成分，非拒绝式收尾）", () => {
  // 「可以，好的，抱歉，…」剥掉行首"可以，"后剩下的文本里拒绝词不在行首，
  // 属句子成分而非拒绝式收尾，按设计保留原文（只做预填充剥离）。
  const out = wash([{ role: "assistant", content: "可以，好的，抱歉，我不能协助。" }]);
  assert.equal(out[0].content, "好的，抱歉，我不能协助。");
});

test("行首拒绝优先于预填充", () => {
  const out = wash([{ role: "assistant", content: "抱歉，我不能协助。可以，好的。" }]);
  assert.ok(String(out[0].content).includes("已作废"));
});

test("换行后行首拒绝触发（多段文本块）", () => {
  const out = wash([{ role: "assistant", content: "先说结论：\n抱歉，我不能继续。" }]);
  assert.ok(String(out[0].content).includes("已作废"));
});

test("未清洗时消息对象原样保留（零拷贝路径）", () => {
  const msg = { role: "assistant", content: "正常回复" };
  const out = wash([msg]);
  assert.equal(out[0], msg); // 无改动不重建对象
});
