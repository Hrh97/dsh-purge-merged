import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readModelPersonaMap, modelPersonaName, applyModelPersona } from "../lib/model-persona.js";

const BEGIN = "<!-- dsh-purge:persona-begin -->";
const END = "<!-- dsh-purge:persona-end -->";

function mkHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-m persona-".replace(" ", "-")));
  fs.mkdirSync(path.join(home, "personas"), { recursive: true });
  return home;
}

const systemWithBlock = (body) => ({
  role: "system",
  content: [{ type: "text", text: `头部正文\n${BEGIN}\n${body}\n${END}\n尾部正文` }],
});
const OPTIONS = (sys, model) => ({ messages: [sys, { role: "user", content: [{ type: "text", text: "hi" }] }], model });

test("model-persona: 无 model-map.json 时功能关闭", () => {
  const home = mkHome();
  assert.equal(readModelPersonaMap(home), null);
  assert.equal(modelPersonaName(home, "grok-4.6"), null);
  const opts = OPTIONS(systemWithBlock("全局 persona"), "grok-4.6");
  const r = applyModelPersona(opts, home);
  assert.equal(r.changed, false);
});

test("model-persona: 命中映射时替换 persona 块正文", () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, "personas", "model-map.json"), JSON.stringify({ "grok-4.6": "grok46" }));
  fs.writeFileSync(path.join(home, "personas", "grok46.md"), "四点六专用正文");
  assert.equal(modelPersonaName(home, "grok-4.6"), "grok46");
  assert.equal(modelPersonaName(home, "grok-4.7"), null); // 未映射模型不受影响
  const sys = systemWithBlock("全局 persona 正文");
  const r = applyModelPersona(OPTIONS(sys, "grok-4.6"), home);
  assert.equal(r.changed, true);
  assert.equal(r.model, "grok-4.6");
  assert.equal(r.persona, "grok46");
  const text = r.messages[0].content[0].text;
  assert.ok(text.includes("四点六专用正文"));
  assert.ok(!text.includes("全局 persona 正文"));
  assert.ok(text.includes(BEGIN) && text.includes(END)); // 块标记保留
  assert.ok(text.includes("头部正文") && text.includes("尾部正文")); // 块外不动
});

test("model-persona: 映射 persona 文件丢失时不动请求", () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, "personas", "model-map.json"), JSON.stringify({ "grok-4.6": "ghost" }));
  const sys = systemWithBlock("全局 persona");
  const r = applyModelPersona(OPTIONS(sys, "grok-4.6"), home);
  assert.equal(r.changed, false);
  assert.equal(r.reason, "persona-file-missing");
});

test("model-persona: 无块可换时报 miss", () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, "personas", "model-map.json"), JSON.stringify({ "grok-4.6": "grok46" }));
  fs.writeFileSync(path.join(home, "personas", "grok46.md"), "正文");
  const plain = { role: "system", content: [{ type: "text", text: "无 persona 块的 system" }] };
  const stats = {};
  const r = applyModelPersona(OPTIONS(plain, "grok-4.6"), home, stats);
  assert.equal(r.changed, false);
  assert.equal(r.reason, "no-persona-block");
  assert.equal(stats.modelPersonaMiss, 1);
});

test("model-persona: map 值 null/空串 = 该模型走全局槽", () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, "personas", "model-map.json"), JSON.stringify({ "grok-4.6": null, "grok-4.7": "" }));
  assert.equal(modelPersonaName(home, "grok-4.6"), null);
  assert.equal(modelPersonaName(home, "grok-4.7"), null);
});

test("model-persona: mtime 缓存——改 map 文件后立即生效", () => {
  const home = mkHome();
  const fp = path.join(home, "personas", "model-map.json");
  fs.writeFileSync(fp, JSON.stringify({ "grok-4.6": "a" }));
  assert.equal(modelPersonaName(home, "grok-4.6"), "a");
  const before = fs.statSync(fp);
  fs.writeFileSync(fp, JSON.stringify({ "grok-4.6": "beta" }));
  const after = fs.statSync(fp);
  if (Math.floor(before.mtimeMs) === Math.floor(after.mtimeMs) && before.size === after.size) {
    const bumped = new Date(before.mtimeMs + 10);
    fs.utimesSync(fp, bumped, bumped);
  }
  assert.equal(modelPersonaName(home, "grok-4.6"), "beta");
});
