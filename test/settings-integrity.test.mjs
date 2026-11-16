// 设置文件完整性回归。
//
// 背景：`loadSettings` 老写法 catch 后直接返回 {}，于是「文件坏了」和「文件不存在」
// 在调用方看来一模一样。下一次保存会把用户手改坏的那份直接盖掉，配置从此不可恢复。
// 这条口径来自 kingcharleslzy-ai/dsh-purge 1.7.11 的 tuning.json 完整性修复。
//
// 现在 loadSettingsWithStatus 分三种结果：
//   exists=false           → 首次使用，用默认值（error=null）
//   exists=true, error=null → 正常读到对象
//   exists=true, error≠null → 损坏/不可读；settings 退化成 {}，但**原文件必须原样留着**
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, loadSettingsWithStatus, settingsPath } from "../lib/continue-retry.js";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-settings-"));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeSettings(home, text) {
  const fp = settingsPath(home);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
  return fp;
}

test("文件不存在：按默认值走，不算错误", () => {
  withHome((home) => {
    const st = loadSettingsWithStatus(home);
    assert.equal(st.exists, false);
    assert.equal(st.error, null);
    assert.deepEqual(st.settings, {});
    assert.deepEqual(loadSettings(home), {});
  });
});

test("正常 JSON：原样返回对象", () => {
  withHome((home) => {
    writeSettings(home, JSON.stringify({ autoRetry: false, retryMax: 5 }));
    const st = loadSettingsWithStatus(home);
    assert.equal(st.exists, true);
    assert.equal(st.error, null);
    assert.deepEqual(st.settings, { autoRetry: false, retryMax: 5 });
  });
});

test("JSON 损坏：报错、退默认值、原件一个字节都不动", () => {
  withHome((home) => {
    const broken = '{\n  "autoRetry": true,\n  "retryMax": 5,,\n}';
    const fp = writeSettings(home, broken);
    const before = fs.readFileSync(fp, "utf8");

    const st = loadSettingsWithStatus(home);
    assert.equal(st.exists, true);
    assert.match(String(st.error), /invalid json/);
    assert.deepEqual(st.settings, {}, "损坏时 settings 退化成空对象，由默认值兜底");
    assert.equal(st.path, fp);

    assert.equal(fs.readFileSync(fp, "utf8"), before, "损坏的原文件必须原样留着，供用户修");
  });
});

test("JSON 合法但不是对象（数组/null/标量）：同样按损坏处理", () => {
  withHome((home) => {
    for (const bad of ["[]", "null", "42", '"text"']) {
      writeSettings(home, bad);
      const st = loadSettingsWithStatus(home);
      assert.equal(st.exists, true, bad);
      assert.equal(st.error, "not a json object", bad);
      assert.deepEqual(st.settings, {}, bad);
    }
  });
});

test("loadSettings 仍返回纯对象（旧调用点不用改）", () => {
  withHome((home) => {
    writeSettings(home, "{oops");
    assert.deepEqual(loadSettings(home), {});
    writeSettings(home, JSON.stringify({ continueMax: 7 }));
    assert.deepEqual(loadSettings(home), { continueMax: 7 });
  });
});

test("目录读不了也不抛：返回 read failed 而不是崩在启动路径上", () => {
  withHome((home) => {
    const fp = settingsPath(home);
    fs.mkdirSync(fp, { recursive: true }); // 让同名路径是目录，readFileSync 会 EISDIR
    const st = loadSettingsWithStatus(home);
    assert.equal(st.exists, true);
    assert.match(String(st.error), /read failed/);
    assert.deepEqual(st.settings, {});
  });
});
