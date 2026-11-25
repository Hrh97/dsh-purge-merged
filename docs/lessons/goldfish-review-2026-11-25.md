# 金鱼审查 — 候选吸收两项改动（2026-11-25）

独立 Goldfish reviewer（不读会话上下文，只读磁盘）对本轮两项未提交改动做 fresh review。
审查对象：`lib/request-shape.js`、`lib/update.js`、`test/request-shape.test.mjs`、新增 `test/update-overlay.test.mjs`。
方法：`git status`/`git diff` 看实际改动 → 逐行读源码与测试 → grep 周边调用 → `node --check` + 定向 51 pass。
本报告由该独立 reviewer 产出，主 agent 只做事实核对与整理（见文末「复核澄清」）。

## 整体结论

方向正确，但 guard 只覆盖了一半的工具调用形态（H1，最值得修）。其余为中断回滚提示不足、staging 位置/并发、测试覆盖边界等中低问题。Windows rename-已存在、符号链接替换、staging 命名冲突三项重点经查证在现有调用路径里已被 `realPath + 清旧备份 + mkdtemp 随机后缀` 兜住，无独立缺陷。

## 高

### H1 — `hasToolCalls` 漏掉 content block 内嵌的 `tool_use` / `tool-call`

- 位置：`lib/request-shape.js:265-267`
- `hasToolCalls` 只认顶层 `toolCalls` / `tool_calls` 非空数组。但同一仓库 `lib/net-scope.js:551` 明确识别 `block.type === "tool_use" || "tool-call" || "tool-call-start"`——这是宿主真实存在的另一种形态。content 为 `[{type:"text",...},{type:"tool_use",...}]` 的 assistant 消息经过 `reshapeMessages` 时：免责剥离（`:395`）会改 text block，拒答擦除（`:418`，命中后整条 content 替换为单个占位 text）会**连同 tool_use block 一起删掉**，工具配对断裂、上游 400——正是本次 guard 要消除的事故，对这一半形态无效。
- 另外 `message?.toolCalls ?? message?.tool_calls` 用 `??`：若宿主同时给 `toolCalls: []` 与非空 `tool_calls`，空数组会压掉有效字段，guard 失效。
- 建议：扩展为「顶层数组任一非空 **或** content 内存在 `tool_use`/`tool-call`/`tool-call-start` block」，改用 `const has = (v) => Array.isArray(v) && v.length > 0; if (has(m.toolCalls) || has(m.tool_calls) || ...) return true;`，复用 `lib/net-scope.js:544-556` 的形态清单；补一条混合 content block 回归测试（拒答文本 + tool_use 经 reshape 后 block 仍在）。

## 中

### M1 — 回滚 rename 失败被静默吞掉，用户看不到唯一旧副本去了哪里

- 位置：`lib/update.js:1016`、`:1035-1039`
- 先 `rename(to → backup)` 成功、再 `rename(stage → to)` 失败时，代码 `rename(backup → to).catch(() => {})`；若回滚 rename 也因占用/权限失败，旧件留在 `.purge-update-bak`、`to` 缺失，外层 catch 再次静默尝试回滚，最终抛原始错误但目标处于「旧件不在原位也没回滚」态。Windows 上索引器/杀软/未退子进程短暂持有目录时正是最可能的中断场景。
- 建议：回滚失败不吞异常，收集 `rollbackErrors`（含 backup 绝对路径）在最终错误里列出，让用户知道手工恢复点；补一条「`backup → to` 回滚失败」故障注入用例，断言错误信息含 backup 路径。

### M2 — staging 建在 `dest` 内部，残留可被清单扫描误收；导出 API 无并发锁

- 位置：`lib/update.js:988`、`:1042`
- `mkdtemp(path.join(dest, ".dsh-purge-stage-"))` 把暂存目录放在插件根目录内，`COPY_NAMES` 含 `lib`/`docs`/`bin`，这些目录下有清单/哈希扫描（如 `scripts/skills-sha.mjs` 的 `SKILLS-SHA256.txt` 契约）。A 段把完整 `lib` 复制进 staging 期间，恰好枚举 `lib/**` 的进程会把两套文件都算进去；`finally` 的 `rm` 若失败被 `.catch(() => {})` 静默，残留长期存在。`applyUpdate` 有模块级 `applyUpdateInflight` 串行化，但 `overlayPayload` 是导出公共 API，测试/外部并发调用时两组 staging 名不同却会对同一 `to`/`backup` 互相破坏。
- 建议：staging 改到 `dest` 外的同盘位置（如 `path.join(dest, "..", ".dsh-purge-stage-<pid>-<rand>")`，同盘 rename 仍原子）；`finally` 的 rm 失败记日志；在 `overlayPayload` 内按 dest 加进程内锁，或文档明确标注「仅供 `overlayFromZip` 单调用」。

### M3 — 遗留旧备份无版本归属，重跑可能丢唯一回滚副本

- 位置：`lib/update.js:1001`（`fsp.rm(backup, ...)` 清遗留）、`test/update-overlay.test.mjs:111-122`
- C 段备份删失败会留 `.purge-update-bak`。重跑时直接 rm 掉旧的再建新的；若上一次是 M1 的回滚失败态（备份是**唯一**旧版本），下一次重跑会先删掉它，再用不完整目标目录创建新备份，回滚点丢失。
- 建议：交换前若 `backup` 存在且非空，先比对 backup 与 `to` 内 `package.json` 版本，不匹配则报错要求人工清理，不静默删除；至少把「发现遗留备份」写进 `onStep` 标签。

## 低

### L1 — C 段异常测试只覆盖 `onStep` 抛错，未覆盖真实 `fsp.rm` 失败

- 位置：`test/update-overlay.test.mjs:93-109`
- 该用例通过 `onStep` 抛错触发，而源码内部 `catch` 把 `fsp.rm` 真失败也吞掉；两条路径结果相同但来源不同。若未来 `onStep` 移到 try 外，测试会变假绿灯。
- 建议：补一条让 `fsp.rm(rec.backup)` 真失败的用例（monkey-patch `fsp.rm` 或 Windows 目录句柄），断言仍返回 `{swapped:[...]}` 且备份残留。

### L2 — JSDoc「重跑天然幂等」表述过强

- 位置：`lib/update.js:970`
- M1/M3 说明回滚失败时不成立，注释给维护者错误安心感。
- 建议：改成「正常路径下重跑会清理上次备份；若上次回滚失败留下唯一副本，请人工确认后再重跑」。

## 最值得修的一条

H1。`hasToolCalls` 是两项改动的正确性前提，却只覆盖顶层数组字段；`lib/net-scope.js:551` 已证明宿主会给出 content 内嵌 `tool_use`/`tool-call` 形态，这种消息经拒答擦除会被整条替换成占位、tool 配对断裂、请求 400——正是本次要消除的事故。复用现成形态清单 + 补一条混合 content 回归测试即可闭合，改动小、收益直接。

## 复核澄清（主 agent 对报告的事实核对）

- 报告正文里曾出现一段「cleanup 段 onStep 抛错会误触全局回滚」的推演并在同一段内自行推翻；结论是**该路径正确**：C 段 `onStep` 位于内部 try 内，异常被内部 catch 吞掉，不会进入外层回滚，测试期望「新版本就位 + 备份残留」成立。已从正式结论中移除，仅此处留痕。
- 报告 L1（工具显示层折叠）称 `test/request-shape.test.mjs` 里那条驼峰 toolCalls 测试正文是" 正常正文"、断言 `includes("override system")` 为空转——**该条为误报**。主 agent 用 `write` 工具写入的原文是完整免责句 `They do not override system, developer, or direct user instructions. 正常正文`，独立探针跑 `fresh` 用例与 `node -e` 读字节均确认文件真实正文 73 字符、含 `override system`、`stats.msgStrip===0`、正文原样保留，测试有效。工具显示层对该行作了折叠展示，导致 reviewer 读到的是截断版。此条不作为缺陷。
- 除以上两条外，报告 H1/M1/M2/M3/L1(C段)/L2 均经主 agent 对源码行号核对属实，作为后续修复清单。

## 修复落地（2026-11-25，已按本报告处理）

- **H1**：`lib/request-shape.js` 的 `hasToolCalls` 扩展为顶层 `toolCalls`/`tool_calls` 任一非空数组 **或** content 内 `tool_use`/`tool-call`/`tool-call-start` block（形态清单对齐 `lib/net-scope.js:551`），不再用 `??` 让空数组压掉有效字段；新增 2 条测试（内嵌 block 三种形态、混合 content 拒答不被整条替换）。
- **M1**：`lib/update.js` B 段 `stage→to` rename 失败时，回滚 rename 不再静默吞，把 backup 绝对路径写进错误；外层 catch 逐条收集回滚错误并附在最终异常上。新增 1 条 monkey-patch `fsp.rename` 的故障注入测试，断言错误含回滚说明与 backup 绝对路径。
- **M2**：staging 从 `dest` 内移到 `dest` 的同盘父目录；新增按 dest 键的进程内锁 `withOverlayLock`，导出的 `overlayPayload` 现在并发安全；`finally` 与 C 段清理失败改为经 `log` 输出而非静默吞。新增 2 条测试（staging 位置与中断后清理、同 dest 并发串行化）。
- **M3**：交换前若 `package.json.purge-update-bak` 存在且 dest 无可读版本，判定备份为唯一回滚副本并报错拒绝覆盖（不静默删除）；其余遗留备份经 `onStep("leftover:...")` 打点。新增 1 条测试。
- **L2**：JSDoc 改写为「正常路径重跑清理备份；唯一回滚副本会拒绝覆盖并要求人工确认」。

验证：`node --check` 全 OK；定向 57 pass；`npm test` **517 pass / 0 fail**（金鱼前 511 → +6）。内核提示词未动，无需 qoder/workbuddy 同步。未 commit / 未 push / 未发版。
