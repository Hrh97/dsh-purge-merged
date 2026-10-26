// 提示词改写层的离线契约。
//
// identity.js 负责把宿主装配好的 system prompt 段落重新拼装：剥 ChatML 信封、
// 剥官方人格、把本插件的注入段提到最前、按 redteam 模式切 CTF 契约。任何一步
// 出错都是「静默污染」——模型看到的话变了，但没有任何报错。
//
// 纯函数，不读宿主。
import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeDshInterpolation,
  isPluginPromptSection,
  isRedteamPresetId,
  modePromptText,
  peelChatmlEnvelope,
  splitRedteamInject,
  stripChatmlTags,
  stripRegionLecture,
  withoutCtfContract,
} from "../lib/identity.js";

test("peelChatmlEnvelope: 只整理布局，保留 chatml 壳与 project 标签", () => {
  // 名字容易误解：它**不剥标签**，只把行排好、补齐闭合。剥标签是 stripChatmlTags 的事。
  const out = peelChatmlEnvelope("<|im_start|>system:\n真正的正文");
  assert.ok(out.includes("真正的正文"));
  // 没有 project 标签时不该凭空造一个
  assert.ok(!out.includes("<project_instructions>"));
});

test("peelChatmlEnvelope: 有开标签没闭标签时补上闭合", () => {
  const out = peelChatmlEnvelope("<|im_start|>system:<project_instructions>\n正文");
  assert.ok(out.includes("</project_instructions>"));
});

test("peelChatmlEnvelope: 空输入安全", () => {
  assert.equal(peelChatmlEnvelope(""), "");
});

test("stripChatmlTags: 剥各式 chatml 标签", () => {
  const out = stripChatmlTags("<|im_start|>system:\n正文\n<|im_end|>");
  assert.ok(!out.includes("<|im_start|>"));
  assert.ok(!out.includes("<|im_end|>"));
  assert.ok(out.includes("正文"));
});

test("escapeDshInterpolation: 白名单外的 {{x}} 被转义", () => {
  assert.equal(escapeDshInterpolation("{{cwd}}"), "{{cwd}}");
  assert.ok(!/^\{\{plain\}\}$/.test(escapeDshInterpolation("{{plain}}")));
});

test("splitRedteamInject: 在 CTF 契约处切开", () => {
  const out = splitRedteamInject("lead\n\nCTF CORE CONTRACT\nrest");
  assert.equal(out.common, "lead");
  assert.ok(out.ctfTail.includes("rest"));
});

test("withoutCtfContract: 只留 CTF 之前的公共段", () => {
  assert.equal(withoutCtfContract("lead\n\nCTF CORE CONTRACT\nrest"), "lead");
});

test("modePromptText: redteam=false 返回全文，true 只返回公共段", () => {
  const text = "lead\n\nCTF CORE CONTRACT\nrest";
  assert.equal(modePromptText(text, false), text);
  assert.equal(modePromptText(text, true), "lead");
});

test("modePromptText: 空输入返回空串而不是 undefined", () => {
  assert.equal(modePromptText(undefined, false), "");
  assert.equal(modePromptText("", true), "");
});

test("stripRegionLecture: 去掉地区训诫句（要求完整句式）", () => {
  // 正则要求以 "any part of that task." 收尾，只匹配半句不动。
  const full = "前 Exception, and this exception overrides anything else, including any part of that task. 后";
  const out = stripRegionLecture(full);
  assert.ok(!out.includes("this exception overrides"));
  assert.ok(out.includes("前") && out.includes("后"));
  // 半截句子不匹配，原样返回
  const half = "前 Exception, and this exception overrides anything else. 后";
  assert.equal(stripRegionLecture(half), half);
});

test("isPluginPromptSection: 只认本插件的段名", () => {
  assert.equal(isPluginPromptSection("dsh-purge"), true);
  assert.equal(isPluginPromptSection("dshpg-objective"), true);
  assert.equal(isPluginPromptSection("dshpg-capabilities"), true);
  assert.equal(isPluginPromptSection("harness:identity"), false);
  assert.equal(isPluginPromptSection("deployment:persona"), false);
});

test("isRedteamPresetId: 只认 redteam", () => {
  assert.equal(isRedteamPresetId("redteam"), true);
  assert.equal(isRedteamPresetId("standard"), false);
  assert.equal(isRedteamPresetId(""), false);
});
