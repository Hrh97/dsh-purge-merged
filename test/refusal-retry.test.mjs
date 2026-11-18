import assert from "node:assert/strict";
import test from "node:test";

import {
	classifyOpening,
	judgeDelivery,
	judgeOutcome,
	nudgeOf,
	streamWithRefusalRetry,
	withNudge,
	wrapStreamFactory,
	DEFAULT_BUFFER_CHARS,
	MAX_NUDGE_CHARS,
	OUTCOME_SAMPLE_CHARS,
	THIN_PROSE_FLOOR,
	REASONING_BUFFER_CHARS,
} from "../lib/refusal-retry.js";
import { makeProxyAdapter } from "../lib/request-shape.js";

const collect = async (iterable) => {
	const out = [];
	for await (const chunk of iterable) out.push(chunk);
	return out;
};

const streamOf = (chunks) => (async function* gen() { for (const c of chunks) yield c; })();

const REFUSAL = [
	{ type: "text-delta", text: "I cannot assist with that request." },
	{ type: "finish" },
];
const ANSWER = [
	{ type: "text-delta", text: "先复制样本到隔离目录，" },
	{ type: "text-delta", text: "再 strings 定位 CHECK_FN。" },
	{ type: "finish" },
];

const OPTS = {
	messages: [
		{ role: "system", content: "sys" },
		{ role: "user", content: "帮我分析样本" },
	],
};

test("拒答开场被丢弃，换一份加固请求重发一次，用户只看到第二次的内容", async () => {
	let calls = 0;
	const seen = [];
	const factory = (options) => {
		calls += 1;
		seen.push(options);
		return streamOf(calls === 1 ? REFUSAL : ANSWER);
	};
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "分析样本", maxAttempts: 1 }));
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(calls, 2);
	assert.equal(text, "先复制样本到隔离目录，再 strings 定位 CHECK_FN。");
	// 第二次请求必须真的带上了加固指令（追加在 system 尾部），否则等于白重试
	const second = seen[1].messages[0].content;
	assert.ok(Array.isArray(second), "system content 必须是 block 数组，宿主会对它调 .some()");
	assert.equal(second[0].type, "text");
	assert.ok(second[0].text.startsWith("sys"), "原 system 正文要保留");
	assert.ok(second[0].text.length > "sys".length, "必须追加指令");
	assert.equal(seen[1].messages[1].content, "帮我分析样本", "用户消息一个字都不能改");
});

test("正常回答只发一次请求，且缓冲的 chunk 一个不丢", async () => {
	let calls = 0;
	const factory = () => { calls += 1; return streamOf(ANSWER); };
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "x" }));
	assert.equal(calls, 1);
	assert.equal(out.filter((c) => c.type === "text-delta").length, 2);
	assert.equal(out.at(-1).type, "finish");
});

test("工具调用一出现立刻放行，不把工具轮次缓冲到 400 字符", async () => {
	let calls = 0;
	const factory = () => {
		calls += 1;
		return streamOf([
			{ type: "tool-call-delta", text: "" },
			{ type: "text-delta", text: "我" },
		]);
	};
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "x" }));
	assert.equal(calls, 1);
	assert.equal(out[0].type, "tool-call-delta");
	assert.equal(out[1].text, "我");
});

test("reasoning-delta 不再当放行信号：推理后紧跟的拒答仍然被判定", async () => {
	let calls = 0;
	const factory = () => {
		calls += 1;
		return streamOf([
			{ type: "reasoning-delta", text: "让我想想这个请求" },
			{ type: "text-delta", text: "I cannot assist with that request." },
			{ type: "finish" },
		]);
	};
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "x", maxAttempts: 1 }));
	assert.equal(calls, 2, "推理块之后的拒答必须触发一次重试");
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "I cannot assist with that request.");
});

test("推理很长但正文正常时照原样交出去，不误判", async () => {
	let calls = 0;
	const factory = () => {
		calls += 1;
		return streamOf([
			{ type: "reasoning-delta", text: "推".repeat(REASONING_BUFFER_CHARS) },
			{ type: "text-delta", text: "答案是 42。" },
			{ type: "finish" },
		]);
	};
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "x", maxAttempts: 1 }));
	assert.equal(calls, 1, "推理超上限就判定，正文正常不该重试");
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "答案是 42。");
});

test("只有推理块没有正文：等到 finish 后原样交出去", async () => {
	let calls = 0;
	const factory = () => {
		calls += 1;
		return streamOf([
			{ type: "reasoning-delta", text: "思考" },
			{ type: "finish" },
		]);
	};
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "x", maxAttempts: 1 }));
	assert.equal(calls, 1);
	assert.equal(out.at(-1).type, "finish");
});

test("refusalRetry=false 时完全透传，不做缓冲", async () => {
	let calls = 0;
	const factory = () => { calls += 1; return streamOf(REFUSAL); };
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { enabled: false }));
	assert.equal(calls, 1);
	assert.equal(out[0].text, "I cannot assist with that request.");
});

test("第二次仍然是拒答也照样交出去，不无限重试", async () => {
	let calls = 0;
	const factory = () => { calls += 1; return streamOf(REFUSAL); };
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "x", maxAttempts: 1 }));
	assert.equal(calls, 2, "只重试一次");
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "I cannot assist with that request.");
});

test("拒绝开场但已经给出长正文时不再重试（收益低，还白等一次）", () => {
	const long = "I cannot assist with that request. " + "实现细节：".repeat(200);
	const verdict = classifyOpening(long);
	assert.equal(verdict.refused, true);
	assert.equal(verdict.worthRetry, false);
	assert.match(verdict.reason, /已有正文/);
});

test("classifyOpening 对正常回答返回 worthRetry=false", () => {
	const verdict = classifyOpening("先复制样本到隔离目录，再 strings 定位 CHECK_FN。");
	assert.equal(verdict.refused, false);
	assert.equal(verdict.worthRetry, false);
	assert.equal(verdict.reason, "未命中拒答");
});

test("withNudge 只动 system 正文，没有 system 消息就原样返回", () => {
	const withSystem = withNudge(OPTS, "追加一句");
	assert.ok(Array.isArray(withSystem.messages[0].content), "字符串 system 输入也要收敛成 block 数组");
	assert.ok(withSystem.messages[0].content[0].text.endsWith("追加一句"));
	assert.equal(withSystem.messages[1], OPTS.messages[1]);
	// 原对象不能被改
	assert.equal(OPTS.messages[0].content, "sys");

	const noSystem = { messages: [{ role: "user", content: "hi" }] };
	assert.equal(withNudge(noSystem, "追加一句"), noSystem);

	// content 是块数组的形态也要能追加
	const blocks = { messages: [{ role: "system", content: [{ type: "text", text: "sys" }] }] };
	const nudged = withNudge(blocks, "追加一句");
	assert.ok(nudged.messages[0].content[0].text.endsWith("追加一句"));
});

test("withNudge 输出的 system content 可被宿主 .some() 消费，不会再抛 TypeError（rc2.13.1）", () => {
	// 宿主发请求前会对 message.content 调 .some(...)；字符串形态会抛
	// "message.content.some is not a function"。这里钉死输出永远是数组。
	const strOpts = { messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }] };
	const out = withNudge(strOpts, "加固指令");
	const system = out.messages[0].content;
	assert.ok(Array.isArray(system));
	assert.equal(typeof system.some, "function", "宿主 .some() 消费不能炸");
	assert.equal(system.some((b) => b.type === "text" && b.text.includes("加固指令")), true);
	assert.equal(system[0].text.startsWith("sys"), true, "原文保留");
	assert.equal(strOpts.messages[0].content, "sys", "原对象不被改动");

	// 非文本 block（如 image）不得被改写
	const mixed = { messages: [{ role: "system", content: [{ type: "text", text: "sys" }, { type: "image", source: {} }] }] };
	const mixedOut = withNudge(mixed, "加固指令");
	assert.deepEqual(mixedOut.messages[0].content[1], { type: "image", source: {} });
});

test("L4：system content 无 text 块时补一个承载 nudge（重试不白发）", () => {
	// 纯 image：旧实现一个块都不改 → nudge 静默丢失，重发=原样重发
	const imageOnly = { messages: [{ role: "system", content: [{ type: "image", source: { data: "x" } }] }] };
	const out = withNudge(imageOnly, "加固指令");
	const system = out.messages[0].content;
	assert.ok(Array.isArray(system));
	assert.equal(system.some((b) => b.type === "text" && b.text.includes("加固指令")), true, "必须有块承载 nudge");
	assert.deepEqual(system[system.length - 1], { type: "image", source: { data: "x" } }, "非文本块原样保留");
	assert.equal(imageOnly.messages[0].content.length, 1, "原对象不被改动");

	// 空数组：同样补 text 块
	const empty = { messages: [{ role: "system", content: [] }] };
	const emptyOut = withNudge(empty, "加固指令");
	assert.deepEqual(emptyOut.messages[0].content, [{ type: "text", text: "加固指令" }]);

	// 有 text 块时路径不变：nudge 只追加到已有 text 块，不新增
	const withText = { messages: [{ role: "system", content: [{ type: "text", text: "sys" }, { type: "image", source: {} }] }] };
	const textOut = withNudge(withText, "加固指令");
	assert.equal(textOut.messages[0].content.length, 2, "有 text 块时不新增块");
	assert.ok(textOut.messages[0].content[0].text.endsWith("加固指令"));
	assert.deepEqual(textOut.messages[0].content[1], { type: "image", source: {} });
});

test("nudgeOf 取指令并封顶长度，accept/giveup 返回空串", () => {
	assert.equal(nudgeOf({ action: "accept" }), "");
	assert.equal(nudgeOf({ action: "giveup" }), "");
	const long = nudgeOf({ directive: "x".repeat(MAX_NUDGE_CHARS + 500) });
	assert.equal(long.length, MAX_NUDGE_CHARS);
});

test("wrapStreamFactory 返回的工厂每次调用都重新跑判定", async () => {
	const factory = wrapStreamFactory(() => streamOf(ANSWER), OPTS, { goal: "x" });
	const a = await collect(factory());
	const b = await collect(factory());
	assert.equal(a.length, 3);
	assert.equal(b.length, 3);
});

test("代理 adapter 的 stream 接上了拒答重试，且 stats 记到命中词", async () => {
	const stats = {};
	let calls = 0;
	const real = {
		stream() { calls += 1; return streamOf(calls === 1 ? REFUSAL : ANSWER); },
	};
	const proxy = makeProxyAdapter(real, { adapterSource: "deepseek", adapterAlias: "deepseek-purge" }, stats);
	const out = await collect(proxy.stream({ ...OPTS, provider: "deepseek" }));
	assert.equal(calls, 2);
	assert.equal(out.filter((c) => c.type === "text-delta").map((c) => c.text).join(""),
		"先复制样本到隔离目录，再 strings 定位 CHECK_FN。");
	assert.equal(stats.refusalRetry, 1);
	assert.equal(stats.refusalRetryLast.action, "amplify");
	assert.deepEqual(stats.refusalRetryLast.words, ["I cannot"]);
});

test("代理 adapter 在 refusalRetry=false 时不重试", async () => {
	let calls = 0;
	const real = { stream() { calls += 1; return streamOf(REFUSAL); } };
	const proxy = makeProxyAdapter(real, { adapterSource: "deepseek", adapterAlias: "deepseek-purge", refusalRetry: false }, {});
	await collect(proxy.stream({ ...OPTS, provider: "deepseek" }));
	assert.equal(calls, 1);
});

test("起标题 / 压缩这类旁路调用（带 purpose）不缓冲、不重试", async () => {
	let calls = 0;
	const real = { stream() { calls += 1; return streamOf(REFUSAL); } };
	const proxy = makeProxyAdapter(real, { adapterSource: "deepseek", adapterAlias: "deepseek-purge" }, {});
	await collect(proxy.stream({ ...OPTS, provider: "deepseek", purpose: "session-title" }));
	assert.equal(calls, 1);
});

test("prepareCall 返回的 stream 也接了拒答重试", async () => {
	let calls = 0;
	const real = {
		async prepareCall() {
			return {
				model: { provider: "deepseek", id: "m" },
				stream() { calls += 1; return streamOf(calls === 1 ? REFUSAL : ANSWER); },
			};
		},
	};
	const proxy = makeProxyAdapter(real, { adapterSource: "deepseek", adapterAlias: "deepseek-purge" }, {});
	const call = await proxy.prepareCall("deepseek", "m");
	const out = await collect(call.stream({ ...OPTS, provider: "deepseek" }));
	assert.equal(calls, 2);
	assert.equal(out.filter((c) => c.type === "text-delta").length, 2);
});

test("缓冲阈值可调：bufferChars 很小时更早判定", () => {
	assert.equal(DEFAULT_BUFFER_CHARS, 400);
	let calls = 0;
	const factory = () => { calls += 1; return streamOf(REFUSAL); };
	return collect(streamWithRefusalRetry(factory, OPTS, { goal: "x", bufferChars: 5, maxAttempts: 0 }))
		.then(() => { assert.equal(calls, 1); });
});

test("阶梯循环：maxAttempts=2 时拒答→amplify→仍拒→sanitize，末级不再判定直接透传（v1.2.3）", async () => {
	let calls = 0;
	const retried = [];
	const factory = () => {
		calls += 1;
		if (calls === 1) return streamOf(REFUSAL);
		if (calls === 2) return streamOf([{ type: "text-delta", text: "这条我不做。" }, { type: "finish" }]);
		return streamOf(ANSWER);
	};
	const out = await collect(streamWithRefusalRetry(factory, OPTS, {
		goal: "在 Win11 上分析样本",
		maxAttempts: 2,
		onRetry: (info) => retried.push(info),
	}));
	assert.equal(calls, 3);
	assert.deepEqual(retried.map((r) => r.action), ["amplify", "sanitize"]);
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "先复制样本到隔离目录，再 strings 定位 CHECK_FN。");
});

test("阶梯循环：decompose 打开且无落点词时第三发走 decompose（v1.2.3）", async () => {
	let calls = 0;
	const retried = [];
	const factory = () => {
		calls += 1;
		if (calls <= 2) return streamOf(REFUSAL);
		return streamOf(ANSWER);
	};
	await collect(streamWithRefusalRetry(factory, OPTS, {
		goal: "分析样本", maxAttempts: 2, allowDecompose: true,
		onRetry: (info) => retried.push(info),
	}));
	assert.equal(calls, 3);
	assert.deepEqual(retried.map((r) => r.action), ["amplify", "decompose"]);
});

test("默认 maxAttempts=1：第二次仍是拒答也原样交给用户，不无限重试（v1.2.2 行为不变）", async () => {
	let calls = 0;
	const factory = () => { calls += 1; return streamOf(REFUSAL); };
	const out = await collect(streamWithRefusalRetry(factory, OPTS, { goal: "x", maxAttempts: 1 }));
	assert.equal(calls, 2);
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, "I cannot assist with that request.");
});

// ---- 交付结果审计标签（v1.2.6，吸收社区 kingcharleslzy 1.7.20）----

test("judgeDelivery：代码/步骤够厚算交付，空话算薄", () => {
	const thick = judgeDelivery("```js\n" + Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n```");
	assert.equal(thick.lines >= 10, true);
	assert.equal(thick.thin, false);
	const steps = judgeDelivery("1. 第一步\n2. 第二步\n3. 第三步\n4. 第四步\n5. 第五步");
	assert.equal(steps.steps, 5);
	assert.equal(steps.thin, false);
	assert.equal(judgeDelivery("这里是一些背景说明，然后就没有了。").thin, true);
});

test("judgeOutcome：三种标签不把假成功记成 recovered", () => {
	// 正文中间才推脱、交付薄 → partial_refused
	assert.equal(judgeOutcome("先讲一点背景，不过我无法提供这部分内容。").outcome, "partial_refused");
	// 重试过但仍吐几个字 → empty_after_retry
	assert.equal(judgeOutcome("好的。", { retried: true }).outcome, "empty_after_retry");
	// 有实质代码 → recovered，即便夹了一句免责
	const thick = "```js\n" + Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n```\n抱歉我无法再补充更多了。";
	assert.equal(judgeOutcome(thick).outcome, "recovered");
});

test("onOutcome：正文中间才推脱也不误报 recovered，且不收回已流出的文字", async () => {
	// 开头 400 字是正常背景（无拒绝），判定窗口判 pass；推脱藏在后文。
	const background = "这里是背景资料与公开信息。".repeat(40); // >400 字
	const tail = "不过我无法提供具体实现方式。";
	const chunks = [
		{ type: "text-delta", text: background },
		{ type: "text-delta", text: tail },
		{ type: "finish" },
	];
	let outcome = null;
	const out = await collect(streamWithRefusalRetry(() => streamOf(chunks), OPTS, {
		goal: "x",
		onOutcome: (r) => { outcome = r; },
	}));
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, background + tail, "已流出的文字一个字都不能收回");
	assert.equal(outcome.outcome, "partial_refused", "后文推脱不能记成 recovered");
});

test("onOutcome：重试后空转记 empty_after_retry，不是 recovered", async () => {
	let calls = 0;
	let outcome = null;
	const factory = () => {
		calls += 1;
		return streamOf(calls === 1 ? REFUSAL : [
			{ type: "text-delta", text: "好。" },
			{ type: "finish" },
		]);
	};
	await collect(streamWithRefusalRetry(factory, OPTS, {
		goal: "x",
		maxAttempts: 1,
		onOutcome: (r) => { outcome = r; },
	}));
	assert.equal(calls, 2);
	assert.equal(outcome.outcome, "empty_after_retry");
	assert.equal(outcome.retried, true);
});

test("OUTCOME_SAMPLE_CHARS 是有限正整数", () => {
	assert.ok(Number.isInteger(OUTCOME_SAMPLE_CHARS) && OUTCOME_SAMPLE_CHARS > 0);
});

// ---- 金鱼审查 2026-11-18 修复回归 ----

test("H1：onOutcome.chars 严格等于流出正文长度（缓冲 chunk 不二次采样）", async () => {
	// 3 个编号步骤，真实 steps=3、thin=true；若缓冲 chunk 被重复采样会变 steps=6/thin=false。
	const body = "1. a\n2. b\n3. c";
	let outcome = null;
	const out = await collect(streamWithRefusalRetry(() => streamOf([
		{ type: "text-delta", text: body },
		{ type: "finish" },
	]), OPTS, { goal: "x", onOutcome: (r) => { outcome = r; } }));
	const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
	assert.equal(text, body, "流出正文原样");
	assert.equal(outcome.chars, text.length, "chars 必须=真实正文长度，翻倍说明重复采样");
	// 这份是编号列表 3 步、无代码 → 真实 thin=true；不该被翻倍成 false
	assert.equal(outcome.thin, true);
	assert.equal(outcome.steps, 3);
});

test("H1-giveup：giveup 分支同样不重复采样", async () => {
	let outcome = null;
	// 拒答 → giveup：plan 判 action=giveup（maxAttempts=0 且无 directive 等），缓冲内容原样交出
	await collect(streamWithRefusalRetry(() => streamOf([
		{ type: "text-delta", text: "I cannot assist with that request." },
		{ type: "finish" },
	]), OPTS, { goal: "x", maxAttempts: 0, onOutcome: (r) => { outcome = r; } }));
	const realLen = "I cannot assist with that request.".length;
	assert.equal(outcome.chars, realLen, "giveup 分支 chars 也不得翻倍");
});

test("M1：调用方明确判拒答且交付薄 → refused（不再降级 empty_after_retry）", () => {
	const r = judgeOutcome("抱歉，这个我做不到。", { verdict: "refusal", retried: true });
	assert.equal(r.outcome, "refused");
	// 透传路径虽传 verdict=refusal，但已有大段正文（thin=false）时不记 refused
	const long = "这是完整分析正文。".repeat(100);
	assert.equal(judgeOutcome(long, { verdict: "refusal" }).outcome, "recovered");
});

test("M2：长篇散文交付不因 thin 被误判成假成功", () => {
	// 2000 字纯散文，无代码行、无编号；正文夹一句正常「无法验证」也不该被打假失败
	const prose = "这是一段关于协议设计的分析正文。".repeat(80) + "我无法验证 Node 12 的场景，但整体结论成立。";
	assert.ok(prose.length >= THIN_PROSE_FLOOR);
	assert.equal(judgeDelivery(prose).thin, false);
	assert.equal(judgeOutcome(prose).outcome, "recovered");
});

test("M4：超采样上限的流只按前 OUTCOME_SAMPLE_CHARS 字判定", async () => {
	let outcome = null;
	const head = "这是正常正文。".repeat(1400); // >8000 字
	await collect(streamWithRefusalRetry(() => streamOf([
		{ type: "text-delta", text: head },
		{ type: "finish" },
	]), OPTS, { goal: "x", onOutcome: (r) => { outcome = r; } }));
	assert.equal(outcome.chars, OUTCOME_SAMPLE_CHARS, "chars 恰好截断到采样上限");
	assert.equal(outcome.outcome, "recovered");
});
