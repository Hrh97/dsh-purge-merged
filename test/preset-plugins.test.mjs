// 预设依赖体检回归。
//
// 事故原型（2026-11 上游合包）：0.2.2 把 `dsh-tool-subagent-control/list-agents`
// 并进主包，红队预设里那一行还是 `disabled: false`，cordis 注册了却永远起不来，
// 整份预设判 broken，模式下拉显示「加载失败」。
//
// 这里把「每个 @deepseek-ai/* 声明要么能 resolve、要么显式 disabled」钉成断言，
// 用合成夹具跑，不依赖本机宿主。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPresets, collectPresetFiles, parsePresetEntries } from "../scripts/check-preset-plugins.mjs";

const PRESET = `
  name: cordis:group
  group: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'
      disabled: false

    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      # 未安装的引擎必须显式关掉，否则整份预设 broken。
      disabled: true
      config:
        provider: spawn

    - id: broken-row
      name: '@deepseek-ai/dsh-does-not-exist-anywhere'
      disabled: false

    - id: local-script
      name: './anchor-gate.mjs'
`;

function fixture(hostPkgs = ["dsh-tool-subagent-control"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-preset-"));
  const presetDir = path.join(root, "presets", "redteam");
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(path.join(presetDir, "agent.cordis.yml"), PRESET, "utf8");

  const host = path.join(root, "host");
  fs.mkdirSync(path.join(host, "node_modules", "@deepseek-ai"), { recursive: true });
  fs.writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "host", version: "0.0.0" }), "utf8");
  for (const pkg of hostPkgs) {
    const dir = path.join(host, "node_modules", "@deepseek-ai", pkg);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: `@deepseek-ai/${pkg}`, version: "0.0.0", main: "index.js" }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "index.js"), "export default {};\n", "utf8");
  }
  return { root, presetDir, host };
}

test("parsePresetEntries 只收有 name 的行，并读 disabled", () => {
  const entries = parsePresetEntries(PRESET);
  assert.deepEqual(
    entries.map((e) => [e.id, e.disabled]),
    [
      ["tool-subagent-control", false],
      ["workflow-worker-thread", true],
      ["broken-row", false],
      ["local-script", null],
    ],
  );
});

test("可解析的行不报问题；显式 disabled 的不可解析行也不报", () => {
  const { root, presetDir, host } = fixture();
  try {
    const rep = checkPresets({ root: presetDir, hostRoot: host });
    assert.equal(rep.hostRoot, host);
    // 唯一的问题必须是 broken-row：不可解析且没 disabled。
    assert.deepEqual(rep.problems.map((p) => p.id), ["broken-row"]);
    assert.equal(rep.ok, false);
    // 非 @deepseek-ai 的名字（本地脚本）不参与判定。
    const local = rep.entries.find((e) => e.id === "local-script");
    assert.equal(local.resolvable, null, "第三方/本地路径不做 resolve 断言");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("补齐缺失的包之后全部 OK", () => {
  const { root, presetDir, host } = fixture(["dsh-tool-subagent-control", "dsh-does-not-exist-anywhere"]);
  try {
    const rep = checkPresets({ root: presetDir, hostRoot: host });
    assert.deepEqual(rep.problems, []);
    assert.equal(rep.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("没有宿主时只做结构断言，不误报", () => {
  const { root, presetDir } = fixture();
  try {
    const rep = checkPresets({ root: presetDir, hostRoot: "" });
    assert.equal(rep.hostRoot, "");
    assert.deepEqual(rep.problems, [], "没有宿主就没法判断可解析性，不能凭此报错");
    assert.equal(rep.ok, true);
    assert.equal(rep.entries.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("仓库自带的预设目录里每个文件都能被解析出来", () => {
  const repoPresets = path.resolve(import.meta.dirname, "..", "presets");
  const files = collectPresetFiles(repoPresets);
  assert.ok(files.length > 0, "至少要扫到一份预设");
  for (const fp of files) {
    const text = fs.readFileSync(fp, "utf8");
    assert.ok(text.trim().length > 0, `${fp} 不能是空文件`);
  }
});

test("仓库自带的红队预设：不可解析的宿主包必须显式 disabled", () => {
  const repoPresets = path.resolve(import.meta.dirname, "..", "presets");
  const host = fs.existsSync("D:/Program Files/DSH/resources/app/dsh/package.json")
    ? "D:/Program Files/DSH/resources/app/dsh"
    : "";
  if (!host) return; // CI 里没有宿主，跳过
  const rep = checkPresets({ root: repoPresets, hostRoot: host });
  assert.deepEqual(rep.problems.map((p) => p.name), [], "预设里不能有「解析不到又没 disabled」的 @deepseek-ai 声明");
});
