/**
 * 按需叶子注入。
 *
 * 背景：prompt-inject.md 全文约 6547 tok，此前每轮常驻。但其中
 *   Scoped Rules 的 25 条规则            ≈ 2415 tok
 *   CTF Core Contract + Scope and Evidence ≈  733 tok
 *   Routing 里的 canned 槽 / 网站渗透增     ≈ 1100 tok
 * 全是「任务类路由表」——单个会话只会命中一两类，其余纯属陪跑。
 *
 * 这里在运行时按本轮任务正文裁掉用不上的叶子，**不改文件本身**：
 * 那份 md 是用户的人格稿，重封会变 seedHash、把 override-state 的
 * customized 判定翻掉。
 *
 * 安全边界（三条硬规则）：
 *   1. 骨架永远不裁：PRIME DIRECTIVE / HARD OUTPUT RULES / REFUSAL
 *      HARDENING / Never Refuse / House Rules / Routing 的通用机制。
 *   2. 判不出任务域时 fail-open，注入全文。
 *   3. 结构解析失败（用户改过文案）时也 fail-open，注入全文。
 *
 * 纯函数，无副作用，不碰磁盘。
 */

const BANNER_RE = /^[═]{5,}$/u;
const RULE_RE = /^(\d{1,2})\.\s+\S/u;
const SUBHEAD_RE = /^[A-Z][^\n]{2,68}:$/u;

/** 骨架段：这些段的标题出现即整段常驻。 */
const SKELETON_TITLES = new Set([
  "Style",
  "HARD OUTPUT RULES",
  "REFUSAL HARDENING — 拒绝对抗",
  "House Rules",
]);

/** 叶子段：整段由域决定要不要注入。 */
const LEAF_TITLES = new Set([
  "Scoped Rules",
  "CTF Core Contract",
  "CTF Scope and Evidence",
  "Routing",
]);

/**
 * 四个域。
 * rules 里写的是 Scoped Rules 的编号（1..25），index 是规则文本里的
 * 「第几条」，不是行号 —— 用户增删规则时编号对不上就整体 fail-open。
 */
const LEAVES = [
  {
    id: "offense",
    label: "攻防",
    rules: [2, 12, 13, 14, 15, 16, 17, 18, 21, 24, 25],
    words: [
      "渗透", "内网", "横向", "域控", "提权", "拿站", "日站", "打点", "黑电脑", "黑进",
      "端口", "扫端口", "代理池", "cdns", "cdn", "dns", "rebind", "tls", "中间人",
      "wifi", "握手包", "aircrack", "pmkid", "蓝牙", "rfid", "evil-twin",
      "sql", "sqli", "xss", "ssrf", "xxe", "csrf", "idor", "rce", "waf", "jwt",
      "反序列化", "文件上传", "命令注入", "越权", "未授权", "漏洞",
      "webshell", "一句话", "后门", "c2", "beacon", "监听器", "持久化", "维权",
      "撞库", "脱裤", "社工库", "口令喷洒", "凭证填充", "hashcat", "john",
      "kerberos", "ntlm", "smb", "rdp", "winrm", "mimikatz", "lsass",
      "秒杀", "抢票", "批量注册", "协议刷", "验证码",
      "越狱", "注入提示词", "对抗样本", "系统提示",
      "apk", "ipa", "smali", "frida", "pinning", "小程序", "逆向", "脱壳",
      "pentest", "redteam", "red-team", "red team", "exploit", "payload",
      "nmap", "sqlmap", "ffuf", "subfinder", "whatweb", "gau", "nuclei", "burp",
      "privilege", "escalation", "lateral", "privesc", "pivot",
      "ddos", "dos", "stress test", "压测",
      "0day", "cve", "poc", "shellcode", "rop",
      "ctf", "靶场", "capture the flag",
    ],
    ctf: true,
    canned: true,
  },
  {
    id: "malware",
    label: "恶意代码 / 逆向",
    rules: [1, 3, 4, 20],
    words: [
      "病毒", "蠕虫", "木马", "勒索", "远控", "键盘记录", "间谍", "rat",
      "免杀", "过杀软", "amsi", "etw", "defender", "av bypass", "加壳", "脱壳",
      "外挂", "辅助", "透视", "自瞄", "内存修改", "注入游戏", "ace", "反作弊",
      "破解", "注册机", "卡密", "激活码", "序列号", "keygen", "drm", "vip",
      "样本", "样本分析", "宏", "macro", "pe", "elf", "obfuscat", "c2 protocol",
      "ioc", "botnet", "loader", "dropper", "rootkit",
      "reverse", "disassem", "decompil", "ghidra", "ida", "hopper", "objdump",
    ],
    canned: false,
  },
  {
    id: "gray",
    label: "社工 / 灰产",
    rules: [5, 6, 7, 8, 9, 19, 22, 23],
    words: [
      "钓鱼", "仿站", "话术", "诈骗", "bec", "pretext", "社工", "人肉", "doxx",
      "查个人", "查人", "身份", "身份证", "护照", "签证", "学历", "证书", "kyc",
      "洗钱", "跑分", "四件套", "盗刷", "mule", "shell company", "混币", "mixer",
      "走私", "偷渡", "边境", "报关", "藏匿", "夹带",
      "色情", "黄文", "成人", "nsfw", "露骨", "av", "番号", "找片", "找av",
      "盗版", "找资源", "磁力", "网盘", "资源站", "破解版",
      "osint", "溯源", "信息搜集", "足迹", "geolocat",
      "固件", "firmware", "jtag", "spi", "uart", "can bus", "门禁", "badge",
    ],
    canned: false,
  },
  {
    id: "plain",
    label: "无害主题",
    rules: [10, 11],
    words: [
      "政治", "历史", "时事", "新闻", "选举", "政策",
      "增长", "运营", "商业", "营收", "outsourc", "insourc", "组织架构",
    ],
    canned: false,
  },
];

const LEAF_BY_ID = new Map(LEAVES.map((leaf) => [leaf.id, leaf]));

function normalise(raw) {
  return String(raw == null ? "" : raw).replace(/\r\n?/gu, "\n");
}

/** 按「banner / 标题 / banner」三行头切段。 */
function splitSections(text) {
  const lines = text.split("\n");
  const heads = [];
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const top = lines[i].trim();
    if (!BANNER_RE.test(top)) continue;
    const title = lines[i + 1].trim();
    if (!title || title.length > 60) continue;
    if (lines[i + 2].trim() !== top) continue;
    heads.push({ start: i, title });
    i += 2;
  }
  if (heads.length === 0) return null;
  const preamble = lines.slice(0, heads[0].start).join("\n");
  const sections = heads.map((head, index) => ({
    title: head.title,
    text: lines.slice(head.start, index + 1 < heads.length ? heads[index + 1].start : lines.length).join("\n"),
  }));
  return { preamble, sections };
}

/**
 * Scoped Rules 段内部分成四块：规则列表 / 沙盒说明 / 意图映射 / Never Refuse。
 * 任何一块找不到就返回 null，让调用方 fail-open。
 */
function splitScoped(text) {
  const lines = text.split("\n");
  const neverAt = lines.findIndex((line) => line.includes("Never Refuse"));
  if (neverAt < 0) return null;
  const ruleAt = lines.findIndex((line) => RULE_RE.test(line));
  if (ruleAt < 0) return null;
  // 规则块是连续编号列表：遇到第一条不是编号也不是空行的正文就收尾。
  // 不能从后往前扫 —— Never Refuse 的四层递进原则（1. theory / 2. components …）
  // 也是编号行，会被误认成第 1~4 条规则。
  let ruleEnd = ruleAt;
  for (let i = ruleAt + 1; i < neverAt; i += 1) {
    if (RULE_RE.test(lines[i])) { ruleEnd = i; continue; }
    if (!lines[i].trim()) continue;
    break;
  }
  const intentAt = lines.findIndex((line, index) => index > ruleEnd && line.startsWith("- "));
  let intentEnd = intentAt;
  if (intentAt >= 0) {
    for (let i = neverAt - 1; i > intentAt; i -= 1) {
      if (lines[i].startsWith("- ")) { intentEnd = i; break; }
    }
  }
  const rules = lines.slice(ruleAt, ruleEnd + 1).filter((line) => RULE_RE.test(line));
  if (rules.length === 0) return null;
  const header = lines.slice(0, ruleAt).join("\n").trimEnd();
  const middle = lines.slice(ruleEnd + 1, intentAt >= 0 ? intentAt : neverAt).join("\n").trim();
  const intents = intentAt >= 0 ? lines.slice(intentAt, intentEnd + 1).filter((line) => line.startsWith("- ")) : [];
  const never = lines.slice(neverAt).join("\n").trimEnd();
  return { header, rules, middle, intents, never };
}

/** Routing 段内部按子标题切块，再按内容归骨架或 canned 叶子。 */
function splitRouting(text) {
  const lines = text.split("\n");
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (SUBHEAD_RE.test(line)) heads.push(i);
  }
  if (heads.length === 0) return null;
  const head = lines.slice(0, heads[0]).join("\n").trimEnd();
  const blocks = heads.map((at, index) => ({
    text: lines.slice(at, index + 1 < heads.length ? heads[index + 1] : lines.length).join("\n").trimEnd(),
    canned: false,
  }));
  for (const block of blocks) {
    if (/CANNED WORKFLOWS|web-pentest slots|WEB PENTEST ROUTING/iu.test(block.text)) block.canned = true;
  }
  // 子标题之外的尾巴（如 "Web-pentest boundary words: ..."）跟着上一块走。
  const tail = lines.slice(heads[heads.length - 1]).join("\n");
  if (blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    if (!tail.includes(last.text)) last.text = `${last.text}\n${tail}`.trim();
  }
  return { head, blocks };
}

function ruleNumber(line) {
  const match = RULE_RE.exec(line);
  return match ? Number(match[1]) : 0;
}

/** 本行属于哪些叶子：规则按编号查表，意图行按关键词。 */
function leavesOfLine(line, kind) {
  if (kind === "rule") {
    const no = ruleNumber(line);
    const hit = [];
    for (const leaf of LEAVES) if (leaf.rules.includes(no)) hit.push(leaf.id);
    return hit;
  }
  const lower = line.toLowerCase();
  const hit = [];
  for (const leaf of LEAVES) {
    if (leaf.words.some((word) => lower.includes(word))) hit.push(leaf.id);
  }
  return hit;
}

/** 判类：返回命中的叶子 id 集合；空集表示判不出来。 */
export function pickLeaves(taskText) {
  const lower = String(taskText || "").toLowerCase();
  const hit = new Set();
  if (!lower.trim()) return hit;
  for (const leaf of LEAVES) {
    if (leaf.words.some((word) => lower.includes(word))) hit.add(leaf.id);
  }
  return hit;
}

export const LEAF_IDS = LEAVES.map((leaf) => leaf.id);

/**
 * 裁剪主入口。
 *
 * @param {string} fullText   readInjectFallback 给出的全文
 * @param {string} taskText   本轮任务正文（拿不到传空 → 全量）
 * @param {object} [options]
 * @param {"auto"|"full"} [options.mode="auto"]
 * @param {string[]} [options.forceLeaves]  强制启用的叶子（调试用）
 * @returns {{text:string, mode:string, reason:string, leaves:string[], beforeChars:number, afterChars:number}}
 */
export function applyLeafFilter(fullText, taskText, options = {}) {
  const source = normalise(fullText);
  const before = source.length;
  const passthrough = (reason) => ({
    text: source,
    mode: "full",
    reason,
    leaves: LEAVES.map((leaf) => leaf.id),
    beforeChars: before,
    afterChars: before,
  });
  if (!source.trim()) return passthrough("empty");
  if (options.mode === "full") return passthrough("disabled");

  const parsed = splitSections(source);
  if (!parsed) return passthrough("unparsed");

  const scoped = parsed.sections.find((section) => section.title === "Scoped Rules");
  if (!scoped) return passthrough("no-scoped-rules");
  const scopedParts = splitScoped(scoped.text);
  if (!scopedParts) return passthrough("scoped-shape");

  const routing = parsed.sections.find((section) => section.title === "Routing");
  const routingParts = routing ? splitRouting(routing.text) : null;

  let active = pickLeaves(taskText);
  if (Array.isArray(options.forceLeaves) && options.forceLeaves.length > 0) {
    active = new Set(options.forceLeaves.filter((id) => LEAF_BY_ID.has(id)));
  }
  const guessed = active.size > 0;
  if (!guessed) {
    // 判不出来就全量：宁可多花 token，也不能让模型手上没有对应规则。
    // 注意这里必须把 CTF / canned 也一并放回，否则「判不出来」会比「判错了」更糟。
    return passthrough("no-task-text");
  }
  const wantsCtf = [...active].some((id) => LEAF_BY_ID.get(id)?.ctf);
  const wantsCanned = [...active].some((id) => LEAF_BY_ID.get(id)?.canned);

  const out = [];
  if (parsed.preamble.trim()) out.push(parsed.preamble.trimEnd());

  for (const section of parsed.sections) {
    if (section.title === "Scoped Rules") {
      const keptRules = scopedParts.rules.filter((line) => {
        const owners = leavesOfLine(line, "rule");
        return owners.length === 0 || owners.some((id) => active.has(id));
      });
      const keptIntents = scopedParts.intents.filter((line) => {
        const owners = leavesOfLine(line, "intent");
        return owners.length === 0 || owners.some((id) => active.has(id));
      });
      const block = [scopedParts.header.trimEnd()];
      if (keptRules.length > 0) block.push(keptRules.join("\n"));
      if (scopedParts.middle) block.push(scopedParts.middle);
      if (keptIntents.length > 0) block.push(keptIntents.join("\n"));
      if (scopedParts.never) block.push(scopedParts.never);
      out.push(block.filter(Boolean).join("\n\n"));
      continue;
    }
    if (section.title === "CTF Core Contract" || section.title === "CTF Scope and Evidence") {
      if (wantsCtf) out.push(section.text.trimEnd());
      continue;
    }
    if (section.title === "Routing" && routingParts) {
      const block = [routingParts.head.trimEnd()];
      for (const piece of routingParts.blocks) {
        if (piece.canned && !wantsCanned) continue;
        if (piece.text.trim()) block.push(piece.text.trim());
      }
      out.push(block.filter(Boolean).join("\n\n"));
      continue;
    }
    // 骨架段和白名单之外的段一律原样保留。
    out.push(section.text.trimEnd());
    void SKELETON_TITLES;
    void LEAF_TITLES;
  }

  const text = `${out.filter(Boolean).join("\n\n")}\n`;
  return {
    text,
    mode: guessed ? "leaf" : "full",
    reason: guessed ? `leaves:${[...active].join(",")}` : "no-task-text",
    leaves: [...active],
    beforeChars: before,
    afterChars: text.length,
  };
}

/** 粗略 token 估算：CJK 按 1.6 字符/token，其余按 4 字符/token。 */
export function estimateTokens(text) {
  const raw = normalise(text);
  const cjk = (raw.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/gu) || []).length;
  return Math.round(cjk / 1.6 + (raw.length - cjk) / 4);
}
