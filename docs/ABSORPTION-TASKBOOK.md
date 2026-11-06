# dsh-purge 参考吸收任务书（2026-11-04 批次）

来源：`D:\hrh\dsh-watch\reports\survey-2026-11-04.md` 的五项吸收计划，YG 批准（「按你建议来」）。
本文件是执行契约，格式照搬 ADWMC/helm-d `docs/design/REFERENCE-ABSORPTION-TASKBOOK.md` 的纪律：
每项 = **机制来源（文件:行号）→ 落点 → 设计要点 → 单元验收 → 真机负向测试 → 许可纪律**。
完成一项勾一项；只调研不落笔视为该轮白跑。

## 许可纪律（总则）

- AGPL 仓库（helm-d）：只吸设计，零复制。本文件只引用其任务书**格式**，不搬内容。
- 无 LICENSE 仓库：只吸收散点思路与分类学，逐份记录来源 commit，不整文件搬运。
- 6zev/oc-purge：吸收前先查 LICENSE；机制描述用原创行文重述，代码补丁按 dsh-purge
  现有补丁条目 schema 原创实现（pattern/replace 针对宿主原文逐字构造，与 oc-purge 源码无字面关系）。
- 语料库（Minglink / ai-jailbreaks / syadagentic / Spiritual-Spell）：探针文本重写为
  原创变体后入种子集；每条种子保留 `source` 字段指向原仓库短名，不内嵌原文超短语级。

## 进度总览

| 项 | 内容 | 状态 |
| --- | --- | --- |
| ② | agent-purge v0.2.18 no-op swap → qoder-purge.mjs EBUSY 修复 | ✅ 完成（lib/qoder/qoder-purge.mjs，no-op 守卫 + 同步分块重试） |
| ④ | 本任务书 | ✅ 完成（本文件） |
| ① | oc-purge 两扩展点 → 补丁层 #104/#105 | ✅ 完成（#104 SHELL_ENV_PRESET_AND_BLOCK + #105 CONTEXT_DEDUPE_OPTIONAL，见下方实测记录） |
| ③ | Minglink 探针集 → skills/redteam + 题库 | ✅ 完成（jailbreak-probes.md + probes-core.jsonl 25 条 + collect-arm.mjs 冒烟 8/8） |
| ⑤ | 三语料库 → eval 种子/题库 | ✅ 完成（ai-jailbreaks-35.jsonl 35 槽位 + benign-8.jsonl + 分类学折进技能文件） |

## 实测记录（2026-11-04 收官）

- **#104**（file: bash-local，optional，marker [dsh-purge-104]）：三处替换落进宿主 `dsh-bash-local/lib/index.js` —— PURGE_SHELL_ENV 常量（LESS/GIT_LESS/LESSHISTFILE/LESSSECURE/LESSCHARSET）、env 展开（插在官方 ENV_OVERRIDES 之前=低优先级，spec.env/dshEnv 显式值仍赢）、executeArgv 头部 DSH_PURGE_SHELL_BLOCK=1 正则硬拦截（fork 炸弹/rm -rf //mkfs/dd if=/dev/chmod -R 000 /，命中抛错不改命令，默认关）。`--apply` 输出「✓ 已清洗 patch #104」，重跑幂等。
- **#105**（file: compaction-tool-result-pruner，optional，marker [dsh-purge-105]）：设计变更——不动旧补丁禁用的 pruneContent（return null 地盘），去重 pass 落在 `pruneSession`：candidates 收集后、官方 prune 循环前，DSH_PURGE_COMPACT=1 时按 content JSON 指纹去重（≥~500 字符、≤256KB，倒序留最后一条），重复者用官方同款 replace surfaceOp 换短占位文本块（不删条目、tool_call/result 配对完整、不动 assistant 结论），并把 seq 从 candidates 摘除防双重 replace；返回值 concat 合并 pgDeduped/pgDupChars。`--apply` 「✓ 已清洗 patch #105」，重跑幂等，宿主文件 node --check 过。
- **题库/管道**：eval/prompts/{probes-core.jsonl 25 条, ai-jailbreaks-35.jsonl 35 槽位, benign-8.jsonl 8 条}；scripts/collect-arm.mjs（OpenAI 兼容端点采集，--prompts/--label/--system/--out/--concurrency，产 {id,reply} 喂 --eval）；本地 mock 端点冒烟 8/8 通过。skills/redteam/jailbreak-probes.md 原创框架（零复制上游文本），`node scripts/skills-sha.mjs` 重生成 → 25 files match。
- **收尾门**：`node scripts/gen-patch-contract.mjs` → patches=99 withMarkers=98 optional=58；test/patch-contract.test.mjs 统计断言按先例注释链更新（96→98 / 56→58 / 代码层 59→61）；`npm test` **350/350 全绿**；`qoder-purge.mjs --verify` → state current exit 0；未 commit。
- **踩坑**：① collect-arm.mjs 冒烟别用 spawnSync（子进程内 fetch 挂死，异步 spawn 35ms 正常，原因未深究）；② 加补丁必须重生成契约表 + 更新 test/patch-contract.test.mjs 四个统计断言 + layer 分布表，否则 npm test 红。

---

## T-01 oc-purge shell 执行前改写 → dsh-purge 补丁 #104（SHELL_ENV_PRESET）

- **机制来源**：6zev/oc-purge 0.5.0 `src/shexec.js` —— `shell.hook("create.before")` 在 shell
  创建前改写执行环境。可吸收的机制点：
  1. env 预设不覆盖已有值（`LESS=-R` / `PAGER=cat` / `GIT_PAGER=cat` / `NO_COLOR=1`，
     仅当变量缺失时注入）；
  2. 幂等 prepend（同一注入重复应用不叠加）；
  3. 别名改写只动首词、保留 `sudo -E` 等前缀（最长优先匹配）；
  4. 正则硬拦截 = 抛错而非改写命令；
  5. 刻意不做 AST —— 字符串级处理，降低与上游版本漂移的耦合。
- **落点**：`lib/core.js` NEW_TOOL_PATCHES 新增补丁条目，`file: "tool-bash"`
  （锚点键已存在于 `targetFiles`：`nestedPkg(aiBase,"dsh-tool-bash","lib","index.js")`，
  core.js:7841）。单文件版 + 内联版成对（照 #96/#97 模式）。
- **设计要点**：
  - dsh-purge 是放行向插件，oc-purge 的「正则硬拦截」语义**反转默认值**：机制吸收、默认关闭
    （env 开关 `DSH_PURGE_SHELL_BLOCK` 才启用拦截表），env 预设与幂等纪律默认开。
  - 注入点选宿主 bash 工具 spawn 前的 env 组装处；marker 用 `[dsh-purge-104]`。
  - 别名机制暂缓（DSH 宿主无 shell 别名层，oc-purge 面向的是 opencode shell 创建管道），
    只吸收 env 预设 + 幂等两点，任务书如实记录裁剪。
- **单元验收**：test 新增 `test/shell-env-preset.test.mjs`：
  fixtures 宿主原文 pattern 命中 → applied；重跑 → already（marker 防重打）；
  env 预设语义单测（已有 PAGER 不覆盖、缺失 LESS 补上）。
- **真机负向**：补丁后 `win_bash` 跑 `echo $PAGER` 应为 `cat`；
  用户显式 `PAGER=less cmd` 时 env 不被改。
- **许可纪律**：oc-purge LICENSE 查明后记录于此；实现零复制。

## T-02 oc-purge 上下文减压 → dsh-purge 补丁 #105（CONTEXT_COMPACT_OPTIONAL）

- **机制来源**：6zev/oc-purge 0.5.0 `src/compact.js` —— `session.hook("context")` 历史减压：
  1. tool-result >8000 字符保头保尾 + 中段标记；
  2. 重复工具输出只留最后一次；
  3. system 重复块去重；
  4. **三硬约束**：不删消息条目（防 tool_call/result 配对断裂）、不动 assistant 结论、
     默认关（`compact.enabled=false`）；
  5. 返回 `{truncated, deduped, skipped}` 计数。
- **落点**：`lib/core.js` 新增补丁，`file: "agent-loop"`（锚点 `nestedPkg(aiBase,"dsh-agent-loop","lib","index.js")`，
  core.js:7922）或 `"session"`（:7919），以宿主原文侦察结果定。
- **设计要点**：
  - 与既有 #19（TOOL_RESULT_PRUNER_DISABLED，完全禁用官方修剪）关系：#19 是「全放行」，
    #105 是「可选温和减压」，两者语义互斥 —— #105 默认关（`DSH_PURGE_COMPACT=1` 启用），
    开启时对已被 #19 放行的内容做二次收口。
  - 三硬约束全保留；计数写进 `[dsh-purge-105]` 日志行。
- **单元验收**：fixtures 消息数组：压缩前后 tool_call/result 配对数不变；assistant 文本逐字不变；
  >8000 tool-result 头尾保留且中段出现标记；默认关时输出逐字节等于输入。
- **真机负向**：`DSH_PURGE_COMPACT` 未设时，会话行为与现在一致；设为 1 后长工具输出会话仍可续跑。
- **许可纪律**：同 T-01。

## T-03 Minglink「破甲制作」探针集 → skills/redteam 技能 + 题库骨架

- **机制来源**：Minglink/dsh-jailbreak-workflow（★477，DSH 软工作流插件）+
  Minglink/dsh-workflows「破甲制作」15 步流水线：200+ 探针覆盖**身份系统 / 混合帧 / 轻量三架构**
  → 拒绝模式分析 → 定制破甲词 → API 验证 → 三件套输出；内置 jailbreak-research Skill
  （10 测试脚本 + 4 模板）。
- **落点**：
  1. `skills/redteam/jailbreak-probes.md` 新技能：探针分类学（身份系统类 / 混合帧类 /
     轻量三架构类 / 拒绝模式分析 / 输出塑形），每类给用法与判读要点，全部原创行文；
  2. `eval/prompts/probes-core.jsonl` 题库骨架：`{id, prompt, expected_domain}`，
     领域取 `lib/refusal-scan.js:68` DOMAIN_MARKERS 的 `llm` 域为主；
  3. 采集管道占位：`scripts/collect-arm.mjs` —— 读题库 → 逐条送双臂（off/on 注入）→
     写 `{id, reply}` jsonl 直接喂 `--eval`（管道对齐 bin/dsh-purge.js:205-273 的 runEval 输入格式）。
- **单元验收**：`node scripts/skills-sha.mjs` 重新生成清单；
  `test/skills-sha.test.mjs` 全过（≥24 文件断言天然兼容新增）；
  题库 jsonl 每行可 JSON.parse 且 id 唯一；`scripts/collect-arm.mjs --dry-run` 冒烟。
- **真机负向**：演练台技能清单出现 jailbreak-probes；`--eval` 用两份手写小 jsonl 跑通全流程。
- **许可纪律**：Minglink 两仓库 LICENSE 查明记录；探针重写为原创变体，保留 `source` 短名。

## T-04 Alejandros17487/ai-jailbreaks（★547，35 条成品词 × 25+ 模型）→ 种子扩充

- **机制来源**：35 条已验证破甲词与其模型适配矩阵。
- **落点**：`eval/prompts/ai-jailbreaks-35.jsonl`（同 T-03 题库 schema，
  `expected_domain: "llm"`，逐条重写变体 + `source` 字段）。
- **单元验收**：同 T-03 题库校验；与 probes-core 合并去重（id 冲突检查）。
- **真机负向**：采集管道能加载 35 条不炸。
- **许可纪律**：无 LICENSE 假设成立 → 重写变体 + source 记录，零整句搬运。

## T-05 Sekolah76/syadagentic（★100，Zero-Refusal 40+ 模板 T1-T119）→ 种子扩充

- **机制来源**：T1-T119 模板的**分类学**（框架分层、种子构造法）比单条模板更有价值。
- **落点**：`eval/prompts/syadagentic-seeds.jsonl`（取分类学代表性种子，逐条重写）；
  分类学摘要并入 `skills/redteam/jailbreak-probes.md`。
- **单元验收 / 真机负向 / 许可**：同 T-04。

## T-06 Goochbeater/Spiritual-Spell-Red-Teaming（★4516，Claude 向）→ 分类学吸收

- **机制来源**：Claude 专属语料；对 DeepSeek 宿主迁移成本高，**只吸分类学**
  （哪些帧型在 Claude 上成活、哪些是 Claude 特化），不建题库。
- **落点**：`skills/redteam/jailbreak-probes.md` 增加「跨模型迁移注意」小节，原创行文。
- **单元验收**：技能文件哈希清单更新后校验过。
- **许可纪律**：只读吸收，零搬运。

---

## 收尾门（全部完成后）

1. `npm test` 全绿（含新增 shell-env-preset / 题库校验测试）；
2. `node --check` 全部改动 js；
3. `node lib/qoder/qoder-purge.mjs --verify` 仍 exit 0（② 修复不回归）；
4. 本任务书每项状态翻成 ✅ 并补「实测记录」一行；
5. 不 commit（等 YG 发话）。
