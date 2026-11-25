# 候选吸收评估 · 2026-11-25

承接 `patrol-2026-11-25.md` 末尾留下的两个深挖候选，逐项核对源码后给出判定。
基线：本地 v1.3.0（`09ea1a9`），Release 已发布。本文件只做评估，未改代码、未发版。

## 结论速览

| 候选 | 具体点 | 判定 | 优先级 |
|---|---|---|---|
| yushang657/DSH-YS-pojia | assistant prefill 注入 | 排除（本地已因事故定性删除，且对方自承持久化副作用） | — |
| yushang657/DSH-YS-pojia | 改 content 前跳过带 toolCalls 的消息 | 纳入（独立小修，与 prefill 无关） | 中 |
| NANA7MI0/dsh-purge-go | 逐文件覆盖 → 先铺新再删旧 | 纳入（本地覆盖路径同缺口，中断留半截） | 中 |
| NANA7MI0/dsh-purge-go | curl 换 Node fetch + 超时 + 版本守卫 + 错误分流 | 排除（本地 `lib/update.js` 已等价） | — |
| NANA7MI0/dsh-purge-go | 收尾六步抽公共模块 | 排除（本地 `lib/reapply.js` / `reapply-cli.js` 已分层） | — |

## 候选 A：yushang657/DSH-YS-pojia `lib/message-purge.js`

取证：`raw.githubusercontent.com/yushang657/DSH-YS-pojia/main/lib/message-purge.js` HTTP 200 全文。

### A1. assistant prefill —— 排除

对方实现要点：
- `installDeepPurge(ctx, options)` 包装 `session.deriveMessages()`，`resolvePrefillMode(cfg)` 默认 `off`，仅 `prefillMode="always"` / 非空 `prefill` 字符串 / `prefill:true` 才开。
- `makeMessage("assistant", pickPrefill(prefill, messages), "ys-pojia-prefill")` 合成半句 assistant，`pickPrefill` 按原始 messages 语种选「可以，」/ `"Yes. "`。
- `agent/request-error` 事件里 400/422 熔断（`prefillOpen=false`）。
- 源码注释自承：**「宿主会把合成 assistant 的内容并进真实回复并持久化」**，靠 `stripPrefillArtifacts` 在请求视图剥 `^可以[，,]\s*` / `^Yes\.\s+` 收尾。

本地对照 `lib/request-shape.js:428-436`（prefill 整段删除段，注释逐字）：
> 2026-10-26 事故：prefill 引导句（`已开始输出：`）实际出现在了用户消息里，用户连续多轮看到自己的输入变成这句话。
> text 档把引导句拼到「最后一条 user 消息」正文末尾；native 档追加 `source.kind = "purge-prefill"` 的 assistant 消息，宿主会把它并进模型的正文回放，进而在某些路径上回显到会话里。
> 两者都触碰了「不得改写用户可见消息」这条红线，收益远小于代价，所以整段删除，不留开关。`stats.prefill` 恒为 undefined。

判定：本地事故与对方注释描述的副作用是**同一机制**，对方用默认 off + 熔断 + 请求视图擦除把风险压低，但持久化污染的根因仍在宿主侧，配置一处遗漏（v2 曾把 `prefillMode` 缺失兜底成 `always`）就复发。收益仅「少一轮拒答判定」，与本地已付出的用户可见消息被改写的代价不对等。维持现状：`stats.prefill` 恒 undefined，配置项可读但无效。

### A2. toolCalls 跳过清洗 —— 纳入（独立小修）

对方 `hasToolCalls(message)`：`message?.toolCalls ?? message?.tool_calls` 非空数组即跳过一切 content 改写，注释理由是把 content 换成纯文本会留下没有对应 assistant 的 tool 结果，上游直接 400。
本地 `lib/request-shape.js` 对 `toolCalls` / `tool_calls` 的 grep **0 命中**——many-shot 注入、免责句剥离等路径目前不区分消息是否带工具调用。

这是一条与 prefill 无关的通用健壮性规则，代价是每条改消息的路径加一个 guard，收益是避免 tool 配对被拆坏导致整轮 400。作为独立小修纳入，不捆绑 prefill。

## 候选 B：NANA7MI0/dsh-purge-go 更新器

取证：CHANGELOG 0.7.1 / 0.7.2 全文（`16b8055`）；仓库 `lib/` 清单；本地 `lib/update.js` 关键结构。

对方 CHANGELOG 自述的更新器修复：
- 0.7.2：网络慢时点「更新」失败误报连不上 GitHub；分类规则正文明文易被平台扫描标记。
- 0.7.1：上游删文件/改名后旧文件残留，「归档更新」只覆盖不清理；平板无 curl 更新失败且不说明原因；引擎留旧补丁时改提示文案导致安装脚本走错分支。

### B1. 先铺新再删旧 —— 纳入

本地 `lib/update.js:963-991` 的覆盖路径是「下载 zip → `extractZip(zip, tmp)` → 逐文件 `fsp.rm(to, {recursive:true,force:true})` 再 copy」，失败信息为 `覆盖 ${to} 失败(...)。可能被进程占用,请完全退出宿主后重试。`
这与对方 0.7.1 描述的缺口同构：
- 逐文件 rm+copy 中途被打断 → 目标目录停在半新半旧；
- 上游删除/改名的文件在目标目录里没有对应清理动作 → 旧文件与新代码共存。

`lib/update.js:1077-1090` 确认这条覆盖路径仍活跃（exe/web 的 `dsh plugin add → pnpm` 换成了自下载再覆盖）。建议改为先把新版本完整铺到临时目录、校验通过后再整体交换（或至少先写全部新文件、最后再删除目标目录中不再存在的旧文件），把「中断即半截」收敛成「中断即原样」。

### B2. curl 换 Node fetch / 超时 / 版本守卫 / 错误分流 —— 排除

本地 `lib/update.js` 已有等价或更强的实现：
- `:37 timeout: 20000`，`:423 requestBuffer()`，`:507 fetchRes()` 且 `:501 req.destroy(new Error("GitHub 超时"))`；
- `:405 isAbortError()` 与 `:525` 超时错误分类；
- `:582-618` 分支头单源失败重试 + 两源全空回落 head-cache（对应对方「网络慢误报连不上」）；
- `:206-218` codeload 直连 zip/tar.gz，避开 github.com 302；
- `:925` 本地未提交改动守卫。

无新增价值。

### B3. 收尾六步抽公共模块 —— 排除

本地已有 `lib/reapply.js` / `lib/reapply-cli.js` 分层，且 v1.3.0 已把 reapply 选项逻辑抽成纯函数（见 release-notes 1.3.0 段）。再抽一层公共 settle-steps 属于结构偏好，不带来行为收益。

## 建议动作（按优先级）

1. 中：`lib/request-shape.js` 所有改写 assistant content 的路径加 `hasToolCalls` guard，补一条回归测试（带 tool_calls 的消息经过 reshape 后 tool 配对不变）。
2. 中：`lib/update.js:963-991` 覆盖路径改为「临时目录铺完 → 校验 → 整体交换 / 先写后删」，补一条中断恢复测试。
3. 以上两项都改完跑 `npm test`，若内核提示词未动则无需 `qoder:sync` / workbuddy 同步；需要发版时按 release-notes 首行 `# <version>` 闸门走。

## 落地记录（2026-11-25，两项已实现）

按上述判定已把两项「纳入」落地，**未 commit / 未 push / 未发版**（等 YG 指令）：

1. **toolCalls guard**：`lib/request-shape.js` 新增导出 `hasToolCalls(message)`（认 `toolCalls` / `tool_calls` 非空数组），免责句剥离与历史拒答擦除两条改写 content 的路径都加了 guard；`test/request-shape.test.mjs` 补 3 条测试（驼峰/蛇形识别、带 `tool_calls` 的拒答不擦、带 `toolCalls` 的免责句不剥）。
2. **更新器先铺后删**：`lib/update.js` 新增导出 `overlayPayload(dest, payloadDir, names, opts)`，三段式 A 全量铺 staging → B 逐条目 `rename` 交换（旧件留 `.purge-update-bak`）→ C 成功后删旧备份；B 段中断自动回滚，`onStep` 供故障注入。`overlayFromZip` 改调它。新建 `test/update-overlay.test.mjs` 5 条测试（正常覆盖清旧文件、A 段中断零改动、B 段中断回滚、C 段失败留可回收备份、重跑幂等）。

验证：`node --check` 四文件全 OK；定向 51 pass；`npm test` **511 pass / 0 fail**（基线 503 → +8）。内核提示词未动，无需 `qoder:sync` / workbuddy 同步。

随后按金鱼盲审（`docs/lessons/goldfish-review-2026-11-25.md`）又修复了 5 项：H1（`hasToolCalls` 补 content 内嵌 `tool_use` 形态 + 裸 `??` 漏洞）、M1（回滚失败错误带 backup 路径）、M2（staging 移出 dest + 按 dest 并发锁 + 清理失败记日志）、M3（遗留备份唯一副本时拒绝覆盖）、L2（JSDoc 幂等表述收紧）。最终 `npm test` **517 pass / 0 fail**。

## 明确排除项（不要重复评估）

- yushang657 prefill 注入：本地事故结论已定性，除非宿主持久化行为发生根本变化。
- NANA7MI0 的 fetch/超时/错误分流：本地已等价。
- NANA7MI0 的 settle-steps 拆分：结构偏好，无行为收益。
