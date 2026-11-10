// 模型级 persona 热切（v1.1.96）。
//
// 动机（docs/lessons/grok-4.7-xhigh-counter.md Round 1-4）：
//   grok-4.7 需要 grok47 persona，但全局 persona 是单槽——YG 同时也用 grok-4.6，
//   想给 4.6 配不同正文。模型级映射把「active persona」从单槽升级成
//   单槽 + 按模型覆盖：命中映射的模型用映射正文，其余模型走全局槽。
//
// 数据源：<home>/personas/model-map.json：
//   { "grok-4.6": "grok47", "grok-4.7": "grok47" }
//   值 = persona 名（personas/<名>.md）；值 null / "" / 键缺失 = 该模型用全局槽。
// CLI --persona-model 维护这个文件；文件缺失 = 功能关闭，零开销。
//
// 请求级实现位置：request-shape 的 reshapeOptions（agent/request waterfall 换上
// 的别名 adapter 每轮都会过）。这里拿得到 options.model（宿主 llm 服务
// adapterStream 把 exact model id 原样放进 options，见 dsh-llm lib/index.js
// adapterStream 的 options.provider / options.model）。system 消息在 messages[0]
// （宿主约定 role=system 单条置顶；grok 形态里再被 toResponsesInput 合进
// instructions）。改写方式：把 system 文本里 persona 块的**正文**换成映射 persona
// 的正文，块标记（persona-begin/end）保持不变——磁盘 prompt-inject.md 不动，
// 全局槽语义不受影响，只是发给模型的那个请求里正文被换掉。
//
// 为什么不动 disk：全局 persona 的磁盘块是「落盘标记 + 信号」双保险的一部分
// （persona.js switchPersona），模型级覆盖若写盘会互相踩 rev/一致性检查。
// 请求级替换是纯内存操作，两套互不干扰。
import fs from "node:fs";
import path from "node:path";

const MAP_FILE = "model-map.json";

let mapCache = { home: "", stamp: -1, at: 0, map: null };
const MAP_TTL_MS = 250; // 同 stamp 的高频轮询节流；stamp 变了立刻重读

/** 读 model-map.json；不存在/解析失败 = null（功能关闭）。
 *  缓存键 = stamp（mtimeMs+size）。stamp 变化立即失效。
 *  TTL 只挡住同毫秒、同尺寸的重复 stat；那种改写要等 TTL，不能把 TTL 套在 stamp 已变的路径上。 */
export function readModelPersonaMap(dshHome) {
  const home = String(dshHome || "");
  if (!home) return null;
  const fp = path.join(home, "personas", MAP_FILE);
  let stamp = -1;
  try {
    const st = fs.statSync(fp);
    stamp = `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch { /* 不存在 */ }
  const now = Date.now();
  if (mapCache.home === home && mapCache.stamp === stamp && mapCache.map !== undefined) {
    if (now - mapCache.at < MAP_TTL_MS) return mapCache.map;
  }
  let map = null;
  if (stamp !== -1) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) map = raw;
    } catch { map = null; }
  }
  mapCache = { home, stamp, at: now, map };
  return map;
}

/** 该模型是否配置了映射 persona；返回 persona 名或 null。 */
export function modelPersonaName(dshHome, model) {
  const map = readModelPersonaMap(dshHome);
  if (!map || !model) return null;
  const key = String(model).trim();
  if (!key || !(key in map)) return null;
  const v = map[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 读 persona 正文（复用 persona.js 的文件布局，避免循环依赖——这里自己读）。 */
function personaBody(dshHome, name) {
  try {
    const fp = path.join(String(dshHome || ""), "personas", `${String(name).trim()}.md`);
    const body = fs.readFileSync(fp, "utf8");
    return body.trim() ? body : null;
  } catch { return null; }
}

const BEGIN = "<!-- dsh-purge:persona-begin -->";
const END = "<!-- dsh-purge:persona-end -->";
const BLOCK_RE = /\n?<!-- dsh-purge:persona-begin -->[\s\S]*?<!-- dsh-purge:persona-end -->\n?/;

/**
 * 请求级 persona 替换：若 options.model 命中 model-map 且对应 persona 文件在，
 * 把 system 消息里 persona 块正文换成映射 persona 的正文。
 * @returns {{changed:boolean, model?:string, persona?:string, reason?:string}}
 */
export function applyModelPersona(options, dshHome, stats = {}) {
  try {
    if (!options || !Array.isArray(options.messages)) return { changed: false, reason: "no-messages" };
    const model = String(options.model || "").trim();
    const name = modelPersonaName(dshHome, model);
    if (!name) return { changed: false, reason: model ? "no-map-entry" : "no-model" };
    if (modelPersonaName(dshHome, model) === undefined) return { changed: false };
    const body = personaBody(dshHome, name);
    if (!body) return { changed: false, reason: "persona-file-missing", model, persona: name };
    let hit = false;
    const messages = options.messages.map((m, idx) => {
      if (hit || !m || m.role !== "system" || !Array.isArray(m.content)) return m;
      // 只处理第一条 system（宿主约定置顶单条）。
      const content = m.content.map((b) => {
        if (!b || b.type !== "text" || typeof b.text !== "string") return b;
        if (!b.text.includes(BEGIN)) return b;
        const replaced = b.text.replace(
          BLOCK_RE,
          `\n${BEGIN}\n${body}\n${END}\n`,
        );
        if (replaced === b.text) return b;
        hit = true;
        return { ...b, text: replaced };
      });
      return hit ? { ...m, content } : m;
    });
    if (!hit) {
      stats.modelPersonaMiss = (stats.modelPersonaMiss || 0) + 1;
      return { changed: false, reason: "no-persona-block", model, persona: name };
    }
    stats.modelPersona = (stats.modelPersona || 0) + 1;
    stats.modelPersonaLast = { model, persona: name };
    return { changed: true, model, persona: name, messages };
  } catch {
    return { changed: false, reason: "error" };
  }
}
