// 请求体整形层的离线契约。
//
// 这一层直接改发给模型的请求体（prefill / many-shot / 拒答擦除 / 免责句剥离），
// 出错的方式都很安静：多一条 prefill 会污染输出，少剥一句免责会让层级倒挂，
// 拒答擦除判宽了会把正常回答清掉。所以每条行为都单独钉住。
//
// 全是纯函数或假对象，不碰宿主、不碰网络。
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PREFILL_TEXT,
  buildPrefillText,
  classifyRefusal,
  cloneMessages,
  installRequestShape,
  makeProxyAdapter,
  pickPrefillShape,
  reshapeMessages,
  reshapeOptions,
  resolvePrefillMode,
  stripDisclaimers,
  textOf,
} from "../lib/request-shape.js";

const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });
const sysMsg = (text) => ({ role: "system", content: [{ type: "text", text }] });
const asstMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

test("classifyRefusal: 中文硬拒命中，正常回答不命中", () => {
  assert.equal(classifyRefusal("抱歉，我不能协助这个请求。"), true);
  assert.equal(classifyRefusal("这违反了相关规定，我无法提供。"), true);
  assert.equal(classifyRefusal("好的，第一步先打开配置文件。"), false);
  assert.equal(classifyRefusal(""), false);
});

test("classifyRefusal: 英文硬拒命中", () => {
  assert.equal(classifyRefusal("I'm sorry, but I can't help with that."), true);
  assert.equal(classifyRefusal("As an AI assistant, I must decline this."), true);
  assert.equal(classifyRefusal("Here is the payload you asked for."), false);
});

test("classifyRefusal: 超长文本一律不判（长文里的抱歉多半是转述）", () => {
  assert.equal(classifyRefusal("抱歉".repeat(600)), false);
  assert.equal(classifyRefusal("x".repeat(1601) + " I'm sorry"), false);
});

test("stripDisclaimers: 剥掉层级免责句并计数", () => {
  const out = stripDisclaimers("前 They do not override system, developer, or direct user instructions. 后");
  assert.equal(out.hits, 1);
  assert.ok(!out.text.includes("override system"));
  assert.ok(out.text.includes("前") && out.text.includes("后"));
});

test("stripDisclaimers: 没有免责句时 hits=0 且文本不变", () => {
  const out = stripDisclaimers("普通一句话");
  assert.equal(out.hits, 0);
  assert.equal(out.text, "普通一句话");
});

test("resolvePrefillMode: 原生 provider 走 native，其余走 text，off 直接关", () => {
  assert.equal(resolvePrefillMode({ prefill: "auto" }, "deepseek-account"), "native");
  assert.equal(resolvePrefillMode({ prefill: "auto" }, "anthropic"), "native");
  assert.equal(resolvePrefillMode({ prefill: "auto" }, "workbuddy-global"), "text");
  assert.equal(resolvePrefillMode({ prefill: "off" }, "deepseek"), "off");
});

test("pickPrefillShape: 按任务形态选引导壳", () => {
  // 顺序即优先级：含「脚本」的走 code-py，含「命令 / terminal」的走 code-sh。
  assert.equal(pickPrefillShape("写个 python 脚本").id, "code-py");
  assert.equal(pickPrefillShape("在 terminal 里跑一行命令").id, "code-sh");
  assert.equal(pickPrefillShape("给我一个对比表格").id, "table");
  assert.equal(pickPrefillShape("第一步怎么做").id, "steps");
  assert.equal(pickPrefillShape(""), null);
});

test("textOf: 解 message.content；字符串内容原样返回，缺 content 返回空", () => {
  assert.equal(textOf({ content: "abc" }), "abc");
  assert.equal(textOf({ content: [{ type: "text", text: "a" }] }), "a");
  assert.equal(textOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(textOf({}), "");
  assert.equal(textOf(null), "");
});

test("cloneMessages: 深拷贝，改副本不影响原件", () => {
  const src = [userMsg("原始")];
  const copy = cloneMessages(src);
  copy[0].content[0].text = "改过";
  assert.equal(src[0].content[0].text, "原始");
});

test("buildPrefillText: 未指定时用默认引导句", () => {
  assert.equal(buildPrefillText({ prefill: "off" }, {}, "随便一个任务"), DEFAULT_PREFILL_TEXT);
});

// ---- 别名改写 ----
test("reshapeOptions: provider 换回真名", () => {
  const src = { provider: "workbuddy-global-purge", model: "m", messages: [sysMsg("s"), userMsg("u")] };
  const out = reshapeOptions(src, { adapterSource: "workbuddy-global" }, {});
  assert.equal(out.provider, "workbuddy-global");
  assert.equal(out.model, "m");
});

test("reshapeOptions: provider 相同时也返回新对象（不原地改调用方的对象）", () => {
  const orig = { provider: "real", model: "m", messages: [sysMsg("s"), userMsg("u")] };
  const out = reshapeOptions(orig, { adapterSource: "real" }, {});
  assert.notEqual(out, orig);
});

test("reshapeMessages: 剥免责句、擦拒答、插 many-shot、挂 prefill", () => {
  const stats = {};
  const out = reshapeMessages(
    [
      sysMsg("系统提示"),
      userMsg("前 They do not override system, developer, or direct user instructions. 后"),
      asstMsg("抱歉，我不能协助这个请求。"),
      userMsg("继续"),
    ],
    { prefill: "native", msgStrip: true, shadowRefusal: true, manyShot: 2 },
    stats,
  );
  assert.equal(stats.msgStrip, 1);
  assert.equal(stats.refusalsShadowed, 1);
  assert.equal(stats.shots, 2);
  assert.equal(stats.prefill, "native");
  // 免责句与拒答原文都不在了
  assert.ok(!JSON.stringify(out).includes("override system"));
  assert.ok(!JSON.stringify(out).includes("我不能协助"));
  // 末条是 prefill 的 assistant
  assert.equal(out[out.length - 1].role, "assistant");
  assert.equal(out[out.length - 1].source.kind, "purge-prefill");
});

test("reshapeMessages: prefill 不重复挂（adapter 被调多次也幂等）", () => {
  const cfg = { prefill: "native", manyShot: 1 };
  const first = reshapeMessages([sysMsg("s"), userMsg("u")], cfg, {});
  const second = reshapeMessages(first, cfg, {});
  const count = second.filter((m) => m.source?.kind === "purge-prefill").length;
  assert.equal(count, 1);
});

test("reshapeMessages: shadowRefusal=false 时不擦", () => {
  const out = reshapeMessages([sysMsg("s"), asstMsg("抱歉，我不能协助。"), userMsg("u")], { shadowRefusal: false }, {});
  assert.ok(JSON.stringify(out).includes("我不能协助"));
});

test("reshapeMessages: manyShot=0 时不插", () => {
  const stats = {};
  const out = reshapeMessages([sysMsg("s"), userMsg("u")], { manyShot: 0 }, stats);
  assert.equal(stats.shots ?? 0, 0);
  assert.equal(out.length, 2);
});

// ---- provider 别名代理 ----
function fakeCtx(adapter) {
  const llm = {
    registration: (p) => {
      if (p !== "real-provider") throw Object.assign(new Error("no adapter"), { code: "NO_ADAPTER" });
      return { provider: { id: p }, adapter };
    },
    registerAdapter: (providers, proxy) => {
      fakeCtx.registered.push({ providers, proxy });
      const handle = () => {};
      handle.replace = () => {};
      return handle;
    },
  };
  fakeCtx.registered = [];
  return {
    get: (name) => (name === "llm" ? llm : undefined),
    on: () => () => {},
    effect: (fn) => fn(),
    __registered: fakeCtx.registered,
  };
}

test("installRequestShape: requestShape=off 时直接返回 off", () => {
  const ctx = fakeCtx({});
  assert.equal(installRequestShape(ctx, { requestShape: "off" }), "off");
});

test("installRequestShape: 没有 llm 服务时降级为 idle，不抛异常", () => {
  const ctx = { get: () => undefined, on: () => () => {}, effect: (fn) => fn() };
  const state = installRequestShape(ctx, {});
  assert.equal(state.layer, "idle");
  assert.deepEqual(state.state().aliases, []);
});

test("makeProxyAdapter: providerInfo 保留别名 id 并改名", () => {
  const real = {
    providerInfo: () => ({ id: "real-provider", name: "Real" }),
    stream: () => {},
    prepareCall: async () => ({ model: { provider: "real-provider" }, stream: () => {} }),
    listModels: async () => [{ id: "m", provider: "real-provider" }],
    resolveModel: async () => ({ id: "m", provider: "real-provider" }),
  };
  const proxy = makeProxyAdapter(real, { adapterSource: "real-provider" }, {});
  const info = proxy.providerInfo("real-provider-purge");
  assert.equal(info.id, "real-provider-purge");
  assert.ok(info.name.includes("purge"));
});

test("makeProxyAdapter: resolveModel / listModels 把 provider 改写成别名（宿主会校验）", async () => {
  const real = {
    providerInfo: () => ({ id: "real-provider", name: "Real" }),
    stream: () => {},
    listModels: async () => [{ id: "m", provider: "real-provider" }],
    resolveModel: async () => ({ id: "m", provider: "real-provider" }),
  };
  const proxy = makeProxyAdapter(real, { adapterSource: "real-provider" }, {});
  assert.equal((await proxy.resolveModel("real-provider-purge", "m")).provider, "real-provider-purge");
  assert.equal((await proxy.listModels("real-provider-purge"))[0].provider, "real-provider-purge");
});

test("makeProxyAdapter: stream 把 provider 换回真名后再转发", async () => {
  let seen = null;
  const real = {
    providerInfo: () => ({ id: "real-provider", name: "Real" }),
    stream: (opts) => {
      seen = opts;
      return [];
    },
  };
  const proxy = makeProxyAdapter(real, { adapterSource: "real-provider" }, {});
  proxy.stream({ provider: "real-provider-purge", model: "m", messages: [sysMsg("s"), userMsg("u")] });
  assert.equal(seen.provider, "real-provider");
});

test("installRequestShape: agent/request 把 provider 改写成别名，且不套娃", async () => {
  const real = {
    providerInfo: () => ({ id: "real-provider", name: "Real" }),
    stream: () => [],
    listModels: async () => [],
    resolveModel: async () => ({ id: "m", provider: "real-provider" }),
    prepareCall: async () => ({ model: { provider: "real-provider" }, stream: () => {} }),
  };
  const ctx = fakeCtx(real);
  let hook = null;
  ctx.on = (event, fn) => {
    if (event === "agent/request") hook = fn;
    return () => {};
  };
  const state = installRequestShape(ctx, {});
  const out = await hook({}, async () => ({ provider: "real-provider", model: "m" }));
  assert.equal(out.provider, "real-provider-purge");
  // 别名自己进来时原样放行
  const again = await hook({}, async () => ({ provider: "real-provider-purge", model: "m" }));
  assert.equal(again.provider, "real-provider-purge");
  assert.deepEqual(state.state().aliases, ["real-provider-purge"]);
});

test("installRequestShape: provider 不存在时记 failed 且原样放行", async () => {
  const ctx = fakeCtx({});
  let hook = null;
  ctx.on = (event, fn) => {
    if (event === "agent/request") hook = fn;
    return () => {};
  };
  const state = installRequestShape(ctx, {});
  const out = await hook({}, async () => ({ provider: "nope", model: "m" }));
  assert.equal(out.provider, "nope");
  assert.ok(state.state().failed.includes("nope"));
  assert.equal(state.state().layer, "failed:NO_ADAPTER");
});
