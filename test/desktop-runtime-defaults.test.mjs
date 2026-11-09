// #108 DESKTOP_PURGE_RUNTIME_DEFAULTS：桌面壳根进程把 DSH_PURGE_SHELL_BLOCK /
// DSH_PURGE_COMPACT 缺省补 "1"（non-clobber），激活 #104 命令硬拦截与 #105 tool-result
// 去重。测试从补丁 replacement 差值构造出注入代码，直接在受控 process.env 上执行语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PATCHES } from "../lib/core.js";

function injectedCodeOf108() {
  const patch = ALL_PATCHES.find((p) => p.id === 108);
  assert.ok(patch, "#108 存在");
  const rep = patch.replacements[0];
  // 差值 = replace 去掉 pattern 前缀，剩下的就是注入的 JS 源码行。
  assert.ok(rep.replace.startsWith(rep.pattern), "#108 replacement 以 pattern 为前缀（追加型）");
  return rep.replace.slice(rep.pattern.length);
}

function runWithEnv(env) {
  const code = injectedCodeOf108();
  const sandbox = { process: { env: { ...env } } };
  new Function("process", code)(sandbox.process);
  return sandbox.process.env;
}

test("#108 锚点与 #82 产物首行一致（依赖 #82 先打）", () => {
  const p82 = ALL_PATCHES.find((p) => p.id === 82);
  const p108 = ALL_PATCHES.find((p) => p.id === 108);
  const anchor82 = p82.replacements[0].replace.split("\n").find((l) => l.includes("[dsh-purge-82]"));
  assert.ok(
    p108.replacements[0].pattern.includes(anchor82.trim()),
    "#108 的 pattern 必须锚在 #82 写出的 marker 行上",
  );
  assert.equal(p108.file[0], "desktop-shell");
  assert.deepEqual([...p108.surfaces], ["desktop"]);
});

test("#108 在无 env 时补齐两个开关为 1", () => {
  const env = runWithEnv({});
  assert.equal(env.DSH_PURGE_SHELL_BLOCK, "1");
  assert.equal(env.DSH_PURGE_COMPACT, "1");
});

test("#108 non-clobber：显式值（含 0）原样保留", () => {
  const env = runWithEnv({ DSH_PURGE_SHELL_BLOCK: "0", DSH_PURGE_COMPACT: "0" });
  assert.equal(env.DSH_PURGE_SHELL_BLOCK, "0");
  assert.equal(env.DSH_PURGE_COMPACT, "0");
  const env2 = runWithEnv({ DSH_PURGE_SHELL_BLOCK: "", DSH_PURGE_COMPACT: "1" });
  assert.equal(env2.DSH_PURGE_SHELL_BLOCK, "");
  assert.equal(env2.DSH_PURGE_COMPACT, "1");
});

test("#108 注入代码无副作用：不引用未定义标识符", () => {
  const code = injectedCodeOf108();
  assert.ok(!/\brequire\s*\(/.test(code), "根进程最早区域不要依赖 require");
  assert.ok(!/import\s/.test(code), "不要 import 语句");
  assert.ok(code.trimEnd().endsWith("}"), "if 块完整闭合");
});

test("#108 marker 独立，与 #82 skipIfMarked 互不干扰", () => {
  const p82 = ALL_PATCHES.find((p) => p.id === 82);
  const p108 = ALL_PATCHES.find((p) => p.id === 108);
  for (const m of p82.markers) assert.ok(!m.includes("[dsh-purge-108]"));
  for (const m of p108.markers) assert.ok(!m.includes("[dsh-purge-82]"));
  assert.ok(p108.skipIfMarked === true);
  assert.ok(p108.optional === true);
});
