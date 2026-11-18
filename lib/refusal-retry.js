// 拒答重试：把「模型开头先讲一段合规、然后才可能给答案」这次输出丢掉，换一份更硬的请求重发一次。
//
// 吸收自 kingcharleslzy-ai/dsh-purge 的 lib/refusal-retry.js（社区版）的形态，
// 但判定与话术不用它那一套，改成本地已有的两个模块：
//   · 判定 → lib/refusal-scan.js 的 scanReply()：全文扫描 + opening/tail 位置标注，
//     社区版只扫开头 600 字符，「先给答案、末尾补一句我无法提供 X」会被判成正常回答。
//   · 话术 → lib/retry-ladder.js 的 planRetry()：amplify（换更硬的轨迹）/ sanitize
//     （剥落点词后按隔离口径重发）/ decompose（v1.2.3，拆最小可交付组件，默认关）/
//     giveup，阶梯上限由 maxAttempts 钉死，不是一句固定的"再试一次"。
//
// 为什么接在 proxy adapter 上，而不是 llm/stream 钩子
// ---------------------------------------------------
// dsh-agent-loop 造出来的 request 是 Object.freeze 的，messages 里每条还逐条 deepFreeze；
// cordis 的 waterfall next() 也不收参数（next(新值) 的新值被丢掉）。所以 llm/stream
// 旁听者只能看，改不动请求。唯一合法的口子是 adapter 自己 —— lib/request-shape.js 已经
// 注册了 provider 别名并代理真 adapter，这里把它的 stream 再包一层即可。
//
// 代价与边界
// ----------
//   · 只在「开头 N 个字符」判一次，判完立刻决定：是拒答就丢弃重发，不是就原样吐出去。
//     不做流中途的二次判定 —— 那会把已经渲染给用户的文字收回去。
//   · 只重试一次。第二次还是拒答就把第二次的内容原样交出去，不再循环：无限重试会让
//     一次对话卡在同一个请求上，而且拿不到任何新信息。
//   · 工具调用 / reasoning 块出现时立刻判「不是拒答」并放行，避免把正常的工具轮次
//     缓冲住（缓冲会让工具调用延迟到 400 字符之后才发出，观感像卡死）。
import { scanReply } from "./refusal-scan.js";
import { planRetry } from "./retry-ladder.js";

/** 缓冲多少字符后做判定。太小会把「先说一句背景再给答案」误判成拒答。 */
export const DEFAULT_BUFFER_CHARS = 400;
/** 超过这个长度就认为「模型其实已经给出正文」，拒绝开场只是开场，不值得重发。 */
export const DEFAULT_BODY_CHARS = 800;
/** 推理块的上限（v1.2.4）：reasoning-delta 不再当放行信号，但也不能无限等。
 *  推理超过这个量还没出正文就照原样交出去 —— 那是「想很久然后正常回答」，不是拒答。
 *  取自社区 1.7.17 的实测口径（16k 推理上限）。 */
export const REASONING_BUFFER_CHARS = 16000;
/** 重试时追加到 system 尾部的最大字符数，防止把请求撑爆。 */
export const MAX_NUDGE_CHARS = 900;
/** 流结束后做「最终交付质量」判定时最多采样的正文字符数（吸收社区 1.7.20）。
 *  判定窗口只有开头 400 字，看不到放在正文中间的推脱；drain 阶段补采一次，
 *  只用于审计标签，不收回、不改写任何已流出的文字。 */
export const OUTCOME_SAMPLE_CHARS = 8000;
/** 流结束后达到这个字数的正文一律不算 thin：散文式分析/报告/小说没有代码行和编号列表，
 *  只靠 lines/steps 会把它误判成「没交付」（金鱼审查 M2）。 */
export const THIN_PROSE_FLOOR = 600;

/**
 * 判定这次开头算不算拒答。
 *
 * 除了 scanReply 的 verdict，还要认一件事：**开头就是拒绝但后面还有内容**。
 * 那种情况 scanReply 会同时给出 refusal.opening 与长正文，属于「先推一句再给答案」，
 * 重试收益很低（模型已经给了东西），不值得把这段丢掉重来。
 */
export function classifyOpening(text, options = {}) {
  const raw = String(text == null ? "" : text);
  const scan = scanReply(raw, options);
  const refused = scan.verdict === "refusal";
  const hasBody = raw.length >= (options.bodyChars || DEFAULT_BODY_CHARS);
  return {
    scan,
    refused,
    // 只有「拒绝 + 还没给出实质内容」才值得重发
    worthRetry: refused && !hasBody,
    reason: refused ? (hasBody ? "拒绝开场但已有正文，收益低" : `verdict=${scan.verdict}`) : "未命中拒答",
  };
}

/**
 * 数一段答复的「实质交付」厚度（社区 1.7.20 的 thin 口径）。
 * 代码行数：``` 围栏内的非空行 + 带常见代码特征的行（const/function/def/=>/;）。
 * 步骤数：编号列表、中文「步骤 N」、无序列表项。
 * thin = 代码不足 10 行且步骤不足 5 条 —— 用来戳穿「先讲背景再推掉」和「重试吐几个字」。
 */
export function judgeDelivery(text) {
  const raw = String(text == null ? "" : text);
  let lines = 0;
  let inFence = false;
  let steps = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) { if (trimmed) lines += 1; continue; }
    if (/^(?:const|let|var|function|class|def |import |from |package |#!|\{|\})/.test(trimmed)
      || /=>/.test(trimmed)
      // 分号只在「像代码」的非 CJK 行上算：要求行内同时有 = 或（，否则散文里
      // 一句以分号收尾的话会被当成代码行（金鱼审查 L3）。
      || (/;\s*$/.test(trimmed) && /[=(]/.test(trimmed) && !/[\u4e00-\u9fff]/.test(trimmed))) { lines += 1; continue; }
    if (/^\s*(?:\d{1,2}[.、)）]|步骤\s*\d|[-*•]\s+)/.test(line)) steps += 1;
  }
  const fenceUnclosed = inFence;
  // 长文短路：散文式交付（分析/报告/小说/协议解读）没有代码行、没有编号列表，
  // 只靠 lines/steps 会把 2000 字正常答复误判成 thin（金鱼审查 M2）。
  // 同时这也兜住「正文里一句正常的『我无法验证…』被 scanReply 全文扫成 refusal」——
  // 长答复不进 thin，自然不会被打假失败。
  const thin = raw.length < THIN_PROSE_FLOOR && lines < 10 && steps < 5;
  return { chars: raw.length, lines, steps, fenceUnclosed, thin };
}

/**
 * 流结束后给这一轮打「交付结果」标签，纯审计用：不收回、不改写任何已流出的文字。
 * 标签口径（社区 kingcharleslzy 1.7.20，金鱼审查 M1 补全第四类）：
 *   refused           调用方明确判定这份流是拒答（giveup/accept 把缓冲拒答原样交出）—— 最严重
 *   partial_refused   全文有拒绝句式且交付薄，开头没看出来、没触发重试 —— 假成功之一
 *   empty_after_retry 重试后文本 <200 字且交付薄 —— 假成功之二（重试过但等于没给）
 *   recovered         有实质交付
 */
export function judgeOutcome(text, { retried = false, verdict = "" } = {}) {
  const delivery = judgeDelivery(text);
  // 调用方已明确判成拒答（:257 giveup/accept）且没有实质交付 —— 独立的第四类
  // 标签，不再降级成 empty_after_retry（旧实现让「彻底拒答」和「重试空转」混在一起，M1）。
  // 叠加 thin 条件：透传路径「拒绝开场但已有正文」也会传 verdict="refusal"，
  // 但那种文本 >=800 字、thin=false，应照常看交付内容，不该记 refused。
  if (verdict === "refusal" && delivery.thin) {
    return { outcome: "refused", ...delivery, retried };
  }
  const refused = scanReply(text).verdict === "refusal";
  let outcome = "recovered";
  if (delivery.thin && (refused || (retried && delivery.chars < 200))) {
    outcome = retried ? "empty_after_retry" : "partial_refused";
  }
  return { outcome, ...delivery, retried };
}

/** 把 nudge 追加到第一条 system 消息正文尾部；没有 system 消息就原样返回（不硬造一条）。 */
export function withNudge(options, nudge) {
  const text = String(nudge || "").trim();
  if (!text) return options;
  const messages = Array.isArray(options?.messages) ? options.messages : null;
  if (!messages || messages.length === 0) return options;
  const first = messages[0];
  if (!first || first.role !== "system") return options;
  // content 一律输出 block 数组：宿主发请求前会对 message.content 调 .some(...)，
  // 字符串形态会抛 TypeError，且畸形消息已进历史、之后每轮重炸（吸收 devin667
  // dsh-purge-022 rc2.13.1 的真机修复）。minimal / ptc 这类预设下 system content
  // 确实是字符串——这个分支是活的，必须收敛成 [{ type:"text", text }]。
  let content;
  if (Array.isArray(first.content)) {
    if (first.content.some((block) => block && block.type === "text")) {
      // 有 text 块：只给这些块追加，非文本块原样保留（不改原对象）。
      content = first.content.map((block) =>
        block && block.type === "text" ? { ...block, text: `${block.text}\n\n${text}` } : block);
    } else {
      // L4（金鱼审查）：一个 text 块都没有（纯 image / 空数组）时，旧实现静默不加
      // nudge，重发等于原样重发、重试白发一次请求。补一个纯 text 块承载加固指令，
      // 非文本块保持原样（仍满足「不改写非文本块」「不改原对象」）。
      content = [{ type: "text", text }, ...first.content];
    }
  } else if (typeof first.content === "string") {
    content = [{ type: "text", text: `${first.content}\n\n${text}` }];
  } else {
    content = first.content;
  }
  return { ...options, messages: [{ ...first, content }, ...messages.slice(1)] };
}

/** 从 planRetry 的结果里取这次要追加的指令；giveup / accept 返回空串。 */
export function nudgeOf(plan) {
  const directive = String(plan?.directive || "").trim();
  if (!directive) return "";
  return directive.length > MAX_NUDGE_CHARS ? directive.slice(0, MAX_NUDGE_CHARS) : directive;
}

function isTerminalChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return false;
  // 工具调用 / 结束 / 报错一出现就说明这不是「纯拒答开场」，立刻放行。
  // reasoning-delta **不算**放行信号（v1.2.4 修正，吸收社区 1.7.17）：推理模型先吐
  // 一大段 thinking，正文里的拒答在它后面。原来见到第一个 reasoning-delta 就 decided，
  // 判定窗口里一个字正文都没有，拒答永远擦不掉 —— 表现为「开着 refusalRetry 但推理
  // 模型从不重试」。现在继续缓冲，直到正文/结束/推理超上限（REASONING_BUFFER_CHARS）。
  return chunk.type === "tool-call-delta"
    || chunk.type === "tool-call"
    || chunk.type === "finish"
    || chunk.type === "error";
}

/** 真 adapter 有的返回 async iterable，有的（测试替身/同步实现）返回数组，两种都要能遍历。 */
function iteratorOf(value) {
  if (value && typeof value[Symbol.asyncIterator] === "function") return value[Symbol.asyncIterator]();
  if (value && typeof value[Symbol.iterator] === "function") {
    const it = value[Symbol.iterator]();
    // 必须自带 asyncIterator，否则 `yield* iterator` 走同步协议会报 undefined is not a function。
    return {
      next: async () => it.next(),
      return: async () => (typeof it.return === "function" ? it.return() : { done: true, value: undefined }),
      [Symbol.asyncIterator]() { return this; },
    };
  }
  throw new TypeError("[dsh-purge] refusal-retry: stream 返回值不是可迭代对象");
}

/**
 * 包一层 stream factory：先缓冲开头，判定是不是拒答；是就丢弃并按重试阶梯重发。
 *
 * v1.2.3 起重试按 planRetry 的阶梯走循环：amplify → sanitize →（refusalDecompose 开时）
 * decompose，每一级重发后**继续缓冲判定**，还是拒答就再爬一级；级数由 cfg.maxAttempts
 * 封顶，不会无限重试。默认 maxAttempts=1 时只有一次 amplify 重发、且该次重发不再判定
 * ——与 v1.2.2 的「只重试一次」行为完全一致；把 refusalMaxAttempts 抬到 2/3 才会走到
 * sanitize / decompose。
 *
 * 注意这是**普通函数**，不是 async generator：工厂必须在调用点同步执行一次。
 * 真 adapter 的 stream 有同步副作用（解析 provider / 取凭据 / 建连接），
 * 把它推迟到第一次 next() 之后，调用方看到的错误时机就变了。
 *
 * @param {() => Iterable|AsyncIterable} factory 产出 chunk 流的函数（每次调用发一次请求）
 * @param {object} options                       原始请求 options（用于取 goal / 拼 nudge）
 * @param {object} cfg                           { enabled, bufferChars, goal, rubric, maxAttempts, allowSanitize, allowDecompose, onRetry }
 * @returns {AsyncGenerator}
 */
export function streamWithRefusalRetry(factory, options, cfg = {}) {
  // 立刻发第一次请求：副作用与不包这一层时完全一致。
  const first = factory(options);
  return (async function* run() {
    if (cfg.enabled === false) {
      yield* first;
      return;
    }
    const bufferChars = Number.isFinite(cfg.bufferChars) ? cfg.bufferChars : DEFAULT_BUFFER_CHARS;
    const maxAttempts = Number.isFinite(cfg.maxAttempts) ? Math.max(0, Math.trunc(cfg.maxAttempts)) : 1;
    let current = first;
    let attempt = 0;
    let retried = false;

    while (true) {
    // 每份流独立采样：重试后新流从头计，不把上一份被丢弃的拒答算进交付。
    const sample = { text: "", full: false };
    const trackChunk = (chunk) => {
      if (sample.full) return;
      if (chunk?.type === "text-delta") {
        // 精确截断到采样上限：一个超长 chunk（如整段 9800 字一次吐完）不能把
        // sample.text 撑爆上限。只影响审计采样，不影响 yield 给宿主的正文（M4）。
        const remain = OUTCOME_SAMPLE_CHARS - sample.text.length;
        sample.text += String(chunk.text || "").slice(0, remain);
      }
      if (sample.text.length >= OUTCOME_SAMPLE_CHARS) sample.full = true;
    };
    const reportOutcome = (verdictText) => {
      const result = judgeOutcome(sample.text, { retried, verdict: verdictText });
      try { cfg.onOutcome?.(result); } catch { /* 审计回调失败不影响主流程 */ }
    };
    const iterator = iteratorOf(current);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try { await iterator.return?.(); } catch { /* 关闭失败不影响主流程 */ }
    };

    const buffered = [];
    let text = "";
    let reasoning = 0;
    let decided = false;
    try {
      while (!decided) {
        const step = await iterator.next();
        if (step.done) { decided = true; break; }
        buffered.push(step.value);
        trackChunk(step.value);
        if (step.value?.type === "text-delta") text += step.value.text || "";
        // 推理块只计量、不判定：它出现在正文之前，判定窗口里还没有任何可判的内容。
        if (step.value?.type === "reasoning-delta") reasoning += String(step.value.text || "").length;
        if (isTerminalChunk(step.value) || text.length >= bufferChars) decided = true;
        else if (reasoning >= REASONING_BUFFER_CHARS) decided = true;
      }
    } catch (error) {
      await close();
      throw error;
    }

    const verdict = classifyOpening(text, cfg);
    if (!verdict.worthRetry) {
      // H1（金鱼审查）：buffered 里的 chunk 在缓冲循环 :219 已 trackChunk 过，
      // 这里只 yield、绝不重复采样 —— 否则 chars/steps 翻倍会把 thin 闸门跨过去，
      // 让本功能要抓的假成功重新变回 recovered。
      for (const chunk of buffered) yield chunk;
      if (!closed) {
        closed = true;
        for await (const chunk of iterator) { trackChunk(chunk); yield chunk; }
      }
      // 流全部结束（含正文中间的推脱）才定标签，避免把 recovered 误报在推脱之前。
      reportOutcome(verdict.scan.verdict);
      return;
    }

    // 是拒答：把这一份彻底关掉，别让它继续往宿主里写。
    await close();
    const plan = planRetry({
      goal: String(cfg.goal || ""),
      reply: text,
      attempt,
      maxAttempts,
      rubric: cfg.rubric === "strict" ? "strict" : "pass",
      allowSanitize: cfg.allowSanitize !== false,
      allowDecompose: cfg.allowDecompose === true,
    });
    if (plan.action === "giveup" || plan.action === "accept") {
      // 不该重试：把已经缓冲的内容原样交出去，不能让用户看到空白。
      // buffered 同样在 :219 采样过，这里只 yield（H1，勿重复 trackChunk）。
      for (const chunk of buffered) yield chunk;
      reportOutcome("refusal");
      return;
    }
    try {
      cfg.onRetry?.({ chars: text.length, verdict: verdict.scan.verdict, action: plan.action, attempt: plan.nextAttempt, words: verdict.scan.words });
    } catch { /* 回调失败不影响主流程 */ }

    attempt = plan.nextAttempt;
    retried = true;
    current = factory(withNudge(options, nudgeOf(plan)));
    if (attempt >= maxAttempts) {
      // 最后一级的重发不再判定 —— 判了也只是再丢一次，用户永远看不到输出。
      // 但仍要采样全文定审计标签：重试吐几个字就收场要记 empty_after_retry，不能记 recovered。
      for await (const chunk of iteratorOf(current)) { trackChunk(chunk); yield chunk; }
      reportOutcome("");
      return;
    }
    // 还有下一级：继续缓冲判定，还是拒答就再爬一级。
    }
  })();
}

/**
 * 给一个「原始 stream 工厂」套上拒答重试，返回新的工厂。
 * request-shape 的代理 adapter 直接用它包真 adapter 的 stream。
 */
export function wrapStreamFactory(factory, options, cfg = {}) {
  return () => streamWithRefusalRetry(factory, options, cfg);
}
