// rc.5 适配回归（2026-11-24）。
//
// 背景：宿主从 0.2.2-rc.3 升到 0.2.2-rc.5，四处官方改动让本地代码静默失效：
//
//   1. dsh.client.inject 里的 @deepseek-ai/dsh-client-runtime / dsh-client-ui-slots
//      在 rc.5 已被移除 → client-modules 解析依赖失败。
//   2. SubagentRuntime 在 rc.4+ 只暴露 listDescendants(rootSessionId, signal)，
//      没有 listChildren → redteam 的并发闸门读到「注册表不可用」。
//   3. dsh-llm 的失败码集合扩容（53 个），CONTENT_REFUSED 等确定性失败没进
//      PERMANENT_CODES → continue-retry 对着内容安全拒答无限重试烧 token。
//   4. dsh-tool-subagent 的 Config 改了键名：modelSelectionSettings → modelSelection,
//      backgroundMode 整个删掉 → 红队预设的子智能体配置静默失效。
//
// 另外 CLI 的宿主识别：普通 node 下 detectSurface() 判成 web，会命中安装目录旁边
// 那份旧 web 副本（host 0.2.1-rc.3），而真正在跑的是桌面客户端（host 0.2.2-rc.5）。
//
// 这些断言不依赖本机宿主：全部用合成夹具 + 纯函数。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 1. client.inject 不再引用 rc.5 已移除的包 ──────────────────────────────

test("package.json 的 dsh.client.inject 不引用 rc.5 已移除的包", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const inject = pkg?.dsh?.client?.inject || [];
  assert.ok(Array.isArray(inject) && inject.length > 0, "inject 清单不能为空");
  for (const gone of ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]) {
    assert.ok(
      !inject.includes(gone),
      `${gone} 在 0.2.2-rc.5 已被移除，写进 inject 会让 client-modules 解析依赖失败`,
    );
  }
  // 本地 #56/#77 两条 rewind 补丁打在 ui-conversation 上，这一项必须留着。
  assert.ok(
    inject.includes("@deepseek-ai/dsh-client-ui-conversation"),
    "ui-conversation 承载 #56/#77 rewind 补丁的载体，不能从 inject 里删掉",
  );
});

test("dshTarget / dshTargets 覆盖 0.2.2-rc.5", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.dshTarget, "0.2.2-rc.5");
  assert.ok(pkg.dshTargets.includes("0.2.2-rc.5"), "dshTargets 必须含 rc.5");
});

// ── 2. continue-retry 的永久失败码 ────────────────────────────────────────

test("CONTENT_REFUSED 等确定性失败算永久失败，不该再自动重试", async () => {
  const { isPermanentFailure } = await import("../lib/continue-retry.js");
  // rc.4+ DeepSeek 内容安全拒答被规范化成独立错误码；此前它会落 MALFORMED_RESPONSE，
  // 看起来像网络抖动，continue-retry 每轮都重发一次，纯烧 token。
  for (const code of [
    "CONTENT_REFUSED",
    "ACCOUNT_SIGN_IN_REQUIRED",
    "ACCOUNT_TOKEN_INVALID",
    "CLIENT_UPGRADE_REQUIRED",
    "MODEL_UNSUPPORTED",
    "UNKNOWN_MODEL",
    "UNSUPPORTED_CONTENT",
    "UNSUPPORTED_OPTION",
    "UNSUPPORTED_REASONING_EFFORT",
    "NO_CREDENTIAL_STORE",
    "INVALID_CONFIG",
    "TOOL_ACTIVATION_FAILED",
    "DSH_TOOL_FORMAT",
  ]) {
    assert.equal(isPermanentFailure(code), true, `${code} 必须是永久失败码`);
    assert.equal(isPermanentFailure(code.toLowerCase()), true, `${code} 大小写不敏感`);
  }
});

test("可重试的失败码仍然不是永久失败", async () => {
  const { isPermanentFailure } = await import("../lib/continue-retry.js");
  for (const code of ["MALFORMED_RESPONSE", "RATE_LIMIT", "TIMEOUT", "STREAM_CLOSED", "TRANSPORT"]) {
    assert.equal(isPermanentFailure(code), false, `${code} 应当可以重试`);
  }
});

// ── 3. redteam 子代理注册表：listDescendants 回退 ──────────────────────────

test("redteam 用 listDescendants 也能算直接子会话（rc.4+ 只有它）", async () => {
  const src = fs.readFileSync(path.join(REPO, "lib", "redteam", "tools.js"), "utf8");
  assert.match(src, /listDescendants/, "tools.js 必须有 listDescendants 回退");
  assert.match(src, /depth === 1/, "按 depth===1 过滤出直接子");
  // 标签回退顺序：label → name → id（rc.5 的 SubagentListEntry 三个都可能为空）
  assert.match(src, /e\.label \|\| e\.name \|\| e\.id/);

  const uiSrc = fs.readFileSync(path.join(REPO, "lib", "redteam", "ui.js"), "utf8");
  assert.match(uiSrc, /listDescendants/, "ui.js 必须有 listDescendants 回退");
  assert.match(uiSrc, /listDirectChildren/);
});

test("redteam 调用子代理注册表前先探测方法是否存在", async () => {
  for (const f of ["tools.js", "ui.js"]) {
    const src = fs.readFileSync(path.join(REPO, "lib", "redteam", f), "utf8");
    // rc.5 只有 listDescendants，没有 listChildren。裸调 listChildren 会抛
    // TypeError；必须先探测方法存在再调。
    assert.match(
      src,
      /typeof\s+\w+\??\.listChildren === 'function'|hasLegacy/,
      `${f} 必须在调用前探测 listChildren 是否存在`,
    );
    assert.match(src, /listDescendants/, `${f} 必须有 listDescendants 回退`);
  }
});

// ── 4. 红队预设迁到 rc.5 的子代理 schema ──────────────────────────────────

test("红队预设不含 rc.5 已删除的子代理配置键", () => {
  const presetPath = path.join(REPO, "presets", "redteam", "agent.cordis.yml");
  const text = fs.readFileSync(presetPath, "utf8");
  // 只查真实配置行（注释里提到这些名字不算）。
  const configLines = text
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, ""))
    .filter((l) => /^\s+[a-zA-Z][a-zA-Z0-9_]*:\s*\S/.test(l));
  for (const key of ["backgroundMode", "modelSelectionSettings", "toolFilter", "persona"]) {
    assert.ok(
      !configLines.some((l) => new RegExp(`^\\s+${key}:`).test(l)),
      `rc.5 的 tool-subagent Config 没有 ${key}，留在预设里会让配置静默失效`,
    );
  }
});

test("红队预设用 modelSelection + modelDiscovery 打开模型选择", () => {
  const presetPath = path.join(REPO, "presets", "redteam", "agent.cordis.yml");
  const text = fs.readFileSync(presetPath, "utf8");
  assert.match(text, /^\s+modelSelection:\s*true$/m, "rc.5 里模型选择开关叫 modelSelection");
  assert.match(text, /^\s+modelDiscovery:\s*true$/m, "模型发现是独立开关");
  assert.match(text, /^\s+maxDepth:\s*1$/m, "子智能体必须收成叶子节点");
});

test("红队预设不再声明 rc.5 已移除的 dsh-workflow-worker-thread", () => {
  const presetPath = path.join(REPO, "presets", "redteam", "agent.cordis.yml");
  const text = fs.readFileSync(presetPath, "utf8");
  // 只看真实声明行：整行注释与行尾注释都不算。
  const declared = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ""))
    .filter((l) => l.includes("dsh-workflow-worker-thread"));
  assert.equal(
    declared.length,
    0,
    "0.2.2-rc.5 没有 dsh-workflow-worker-thread 这个包，这一行应删掉",
  );
});

// ── 5. CLI 宿主识别：桌面在跑时不能报旧 web 副本 ──────────────────────────

test("looksLikeStaleBase 认得包管理器缓存与归档残留", async () => {
  const { looksLikeStaleBase } = await import("../lib/core.js");
  for (const p of [
    "C:/Users/onemt/AppData/Local/npm-cache/_npx/600081e5c584a85c/node_modules/@deepseek-ai",
    "C:/Users/onemt/AppData/Local/npm-cache/_cacache/content-v2/@deepseek-ai",
    "D:/hrh/store/.pnpm/@deepseek-ai+dsh@0.2.1-rc.3/node_modules/@deepseek-ai",
    "C:/Users/onemt/.dsh/_archived-web/node_modules/@deepseek-ai",
  ]) {
    assert.equal(looksLikeStaleBase(p), true, `${p} 应判为陈旧副本`);
  }
  for (const p of [
    "D:/Program Files/DSH/resources/app/dsh/node_modules/@deepseek-ai",
    "D:/hrh/dsh/node_modules/@deepseek-ai",
  ]) {
    assert.equal(looksLikeStaleBase(p), false, `${p} 是正常安装路径，不该判陈旧`);
  }
  assert.equal(looksLikeStaleBase(""), false);
  assert.equal(looksLikeStaleBase(null), false);
});

test("桌面在跑时 findAiBase 选桌面宿主而不是旧 web 副本", async () => {
  const core = await import("../lib/core.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-rc5-"));
  const oldWeb = path.join(root, "old-web", "node_modules", "@deepseek-ai");
  const desktopBase = path.join(root, "app", "dsh", "node_modules", "@deepseek-ai");
  for (const base of [oldWeb, desktopBase]) {
    fs.mkdirSync(path.join(base, "dsh-agent-instructions", "lib"), { recursive: true });
    fs.mkdirSync(path.join(base, "dsh"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "dsh", "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: base === desktopBase ? "0.2.2-rc.5" : "0.2.1-rc.3" }),
      "utf8",
    );
  }

  const prevEnv = { ...process.env };
  try {
    // 让 findAiBaseWeb 命中旧 web 副本，runningDesktop 命中桌面那份。
    process.env.DSH_BASE = oldWeb;
    core.resetPathMemo();

    assert.equal(
      core.findAiBase({ runningDesktop: () => desktopBase }),
      desktopBase,
      "桌面客户端在跑时应选桌面宿主",
    );
  } finally {
    process.env.DSH_BASE = prevEnv.DSH_BASE;
    if (prevEnv.DSH_BASE === undefined) delete process.env.DSH_BASE;
    core.resetPathMemo();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("桌面没在跑时保持 web 优先，不改变既有行为", async () => {
  const core = await import("../lib/core.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-rc5-web-"));
  const webBase = path.join(root, "web", "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(webBase, "dsh-agent-instructions", "lib"), { recursive: true });

  const prevEnv = { ...process.env };
  try {
    process.env.DSH_BASE = webBase;
    core.resetPathMemo();

    assert.equal(
      core.findAiBase({ runningDesktop: () => "" }),
      webBase,
      "没有桌面客户端在跑时应保持 web 宿主",
    );
  } finally {
    process.env.DSH_BASE = prevEnv.DSH_BASE;
    if (prevEnv.DSH_BASE === undefined) delete process.env.DSH_BASE;
    core.resetPathMemo();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 6. desktop.js 提供 runningDesktopAiBase ───────────────────────────────

test("desktop.js 导出 runningDesktopAiBase 且缓存可清", async () => {
  const desktop = await import("../lib/desktop.js");
  assert.equal(typeof desktop.runningDesktopAiBase, "function");
  assert.equal(typeof desktop.clearDesktopLocateCache, "function");
  // 没有桌面客户端在跑时返回空串，不抛异常。
  const base = desktop.runningDesktopAiBase();
  assert.ok(base === "" || typeof base === "string");
});
