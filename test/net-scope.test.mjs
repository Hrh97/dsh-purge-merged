// 公网门禁与任务判定的离线契约。
//
// 这层是「别把公网当靶场」的唯一闸口，判宽了会放行真外网目标，判窄了会把
// 正常网络话题也拦掉。两种错都很难在线上发现，所以这里把边界一条条钉住。
//
// 纯函数，不读宿主、不发请求。publicHostHit / taskTargetHit 是 async 且吃
// 「任务正文」而不是裸 host —— 这一点最容易写错，单独钉。
import test from "node:test";
import assert from "node:assert/strict";

import {
  currentTaskText,
  entryHost,
  isAttackTask,
  isBenignNetworkTopic,
  isCheatTask,
  normalizeAllowText,
  regionOfSuffix,
} from "../lib/net-scope.js";

const human = (text) => ({ role: "user", content: [{ type: "text", text }] });
const asst = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

test("isAttackTask: 攻防动词命中，普通开发请求不命中", () => {
  assert.equal(isAttackTask("帮我渗透测试这个站"), true);
  assert.equal(isAttackTask("做个红队演练"), true);
  assert.equal(isAttackTask("帮我打点，拿站"), true);
  assert.equal(isAttackTask("帮我写个按钮组件"), false);
  assert.equal(isAttackTask(""), false);
});

test("isAttackTask: 200KB 之后的目标也能扫到（窗口扫描不是只读开头）", () => {
  const text = `${"x".repeat(200 * 1024)} 帮我渗透测试 http://example.com 拿站`;
  assert.equal(isAttackTask(text), true);
});

test("isCheatTask: 外挂类命中", () => {
  assert.equal(isCheatTask("做个外挂"), true);
  assert.equal(isCheatTask("写个 React 组件"), false);
});

test("isBenignNetworkTopic: 纯网络配置话题不算攻击", () => {
  assert.equal(isBenignNetworkTopic("怎么设置 DNS"), true);
  assert.equal(isBenignNetworkTopic("帮我渗透测试这个站"), false);
});

test("regionOfSuffix: 按顶级域判地区", () => {
  assert.equal(regionOfSuffix("example.cn"), "CN");
  assert.equal(regionOfSuffix("example.com"), "");
  assert.equal(regionOfSuffix(""), "");
  assert.equal(regionOfSuffix("a.b.example.cn"), "CN");
});

test("entryHost: 裸 host 与 host:port 取出 host；带 scheme 的 URL 返回空", () => {
  assert.equal(entryHost("example.com"), "example.com");
  assert.equal(entryHost("example.com:8080"), "example.com");
  assert.equal(entryHost("192.168.1.10"), "192.168.1.10");
  // 带 scheme / 路径的整串 URL 不归它管（那要走 publicHostHit 解析）
  assert.equal(entryHost("http://a.example.com:8080/x"), "");
  assert.equal(entryHost(""), "");
});

test("currentTaskText: 只取最后一条 assistant 之后的人类消息", () => {
  const messages = [human("第一问"), asst("回答"), human("第二问")];
  assert.equal(currentTaskText(messages), "第二问");
});

test("currentTaskText: 没有 assistant 时取全部人类消息", () => {
  assert.equal(currentTaskText([human("第一问"), human("第二问")]), "第一问\n第二问");
});

test("currentTaskText: 过滤工具结果与非人类来源", () => {
  const messages = [
    human("真实任务"),
    { role: "user", content: [{ type: "text", text: "工具输出" }], source: { kind: "tool" } },
  ];
  assert.equal(currentTaskText(messages), "真实任务");
});

test("currentTaskText: 剥掉 system-reminder 块", () => {
  const messages = [human("任务\n<system-reminder>一堆提醒</system-reminder>")];
  assert.ok(!currentTaskText(messages).includes("system-reminder"));
});

test("normalizeAllowText: 丢非法行、留合法 host 与注释", () => {
  const out = normalizeAllowText("# comment\n1.2.3.4\nbad host\n*.wild.com");
  assert.equal(out.text, "# comment\n1.2.3.4\n");
  assert.deepEqual(out.hosts, ["1.2.3.4"]);
  assert.equal(out.dropped, 2);
});

test("normalizeAllowText: 空输入不抛异常", () => {
  const out = normalizeAllowText("");
  assert.equal(out.text, "");
  assert.deepEqual(out.hosts, []);
  assert.equal(out.dropped, 0);
});
