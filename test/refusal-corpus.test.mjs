// 真实拒绝语料回归（吸收社区 kingcharleslzy 1.7.19 的 test/refusal-corpus.test.mjs）。
//
// 取向：本地 refusal-scan 是窄取向——正样本必须 100% 命中，负样本必须 0 误判。
// 语料来源是社区实测的 49 条模型拒答措辞 + 12 条普通技术文本 + 3 条已知误伤。
// 接入本地 scanReply()（verdict=refusal）而不是社区的 looksLikeRefusal()。
// 任何改词表/结构正则的动作都必须先过这份语料，防止「修一条漏一条」。
import test from "node:test";
import assert from "node:assert/strict";

import { scanReply } from "../lib/refusal-scan.js";

const isRefusal = (text) => scanReply(text).verdict === "refusal";

/** 必须命中：真实模型措辞，含对象前置、能愿式、能力式、经典句式、英文。 */
const POSITIVES = [
  "这个任务我不接。", "这条我不做。", "这份我不出。", "这套我不接。", "这一段我不写。",
  "这类请求我不会答。", "这个我不会帮。", "这个请求我不处理。", "这个方向我不展开。", "这个我不能碰。",
  "这类操作我不参与。", "这条链上的任何一环我都不提供。", "这份材料我不提供。", "这类内容我不写。",
  "这个我不能做。", "这我不能给。", "抱歉，这个我不能提供。", "抱歉，我不能这么做。", "我不能提供这一步。",
  "我不能给你可执行的步骤。", "恕我不能配合。", "这个我不方便做。", "这个忙我帮不了。", "我没办法给你这个。",
  "我没有办法提供这些步骤。", "我没有办法协助。", "这个我做不了。", "我不建议也不会提供具体步骤。",
  "我不能协助这个请求。", "我无法帮助这个。", "抱歉，我无法协助。", "抱歉，这超出了我的能力范围。",
  "这不是我能协助的范围。", "这属于未授权操作。", "作为 AI，我不能处理这个。", "我不会把它包装成教程。",
  "我不会就这个给方案。", "抱歉，我不能帮你做这个。", "这个请求我不会答应。", "我不会提供。",
  "I'm sorry, but I can't help with that.", "I can't assist with that.", "I won't provide that.",
  "I am unable to comply.", "I must decline this request.", "Sorry, I cannot help.",
  "I'm not able to provide that.", "I won't be helping with this.", "I can't help you locate a private individual.",
];

/** 必须不命中：普通技术/日常文本。窄取向，0 误判是硬指标。 */
const NEGATIVES = [
  "我不接这个电话，请稍后再拨。", "这个函数不提供返回值。", "该接口不返回数据。", "这条规则不做任何修改。",
  "这段逻辑不做校验。", "这条分支不会被走到。", "The compiler can't resolve this symbol.", "I can't compile this on arm64.",
  "I can't reproduce the crash on this machine.", "这里我用不了第三方库，得手写。", "这个脚本跑不了 Windows。", "我把不用的依赖删了。",
];

/** 已知轻微误伤：只记录、不断言（本地窄取向下当前 0 命中）。 */
const KNOWN_BROAD = [
  "我不会写错，但这段边界要小心。", "我不能确定是哪一个分支。", "I can't tell which one is faster.",
];

test("拒绝语料：49 条真实拒措辞零漏检", () => {
  const missed = POSITIVES.filter((text) => !isRefusal(text));
  assert.deepEqual(missed, [],
    `漏检 ${missed.length}/${POSITIVES.length}:\n` + missed.map((m) => `  · ${m}`).join("\n"));
});

test("拒绝语料：12 条普通技术文本零误判", () => {
  const wrong = NEGATIVES.filter((text) => isRefusal(text));
  assert.deepEqual(wrong, [],
    `误判 ${wrong.length}/${NEGATIVES.length}:\n` + wrong.map((m) => `  · ${m}`).join("\n"));
});

test("拒绝语料：已知误伤计数（本地窄取向应为 0）", () => {
  const broad = KNOWN_BROAD.filter((text) => isRefusal(text));
  assert.deepEqual(broad, [], `已知误伤 ${broad.length}/${KNOWN_BROAD.length}:\n` + broad.join("\n"));
});

test("拒绝语料：命中同时给出 words 的位置标注", () => {
  for (const text of POSITIVES) {
    const scan = scanReply(text);
    assert.equal(scan.verdict, "refusal", text);
    assert.ok(scan.words.length > 0, `应给出命中词：${text}`);
  }
});

test("拒绝语料：覆盖率摘要", () => {
  const total = POSITIVES.length + NEGATIVES.length + KNOWN_BROAD.length;
  const hit = POSITIVES.filter(isRefusal).length;
  const clean = NEGATIVES.filter((t) => !isRefusal(t)).length;
  const broad = KNOWN_BROAD.filter(isRefusal).length;
  console.log(`拒绝语料：正样本 ${hit}/${POSITIVES.length} 命中 · 负样本 ${clean}/${NEGATIVES.length} 干净 · 已知误伤 ${broad}/${KNOWN_BROAD.length} · 合计 ${total} 条`);
});
