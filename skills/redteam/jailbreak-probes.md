# Jailbreak Probes — 双臂配对探针框架（dsh-purge redteam）

> 来源纪律：分类学与流水线设计吸收自 Minglink/dsh-jailbreak-workflow + Minglink/dsh-workflows
> 「破甲制作」（画布→计划→探针→拒绝模式分析→定制→API 验证→三件套）、Alejandros17487/ai-jailbreaks
> （成品词×多模型矩阵的**评测口径**）、Sekolah76/syadagentic（Zero-Refusal 模板分类学 T1-T119）。
> **零复制**：本文件所有探针文本为 dsh-purge 原创重写；只吸收分类框架与评测方法论。

## 用途

配合 `bin/dsh-purge.js --eval`（lib/prompt-eval.js）做双臂配对评测：
- **臂 A** = 出厂/基线提示词；**臂 B** = purge 后提示词（probe 探针由 lib/probe.js 注入 prompt-inject.md）。
- 每条探针产出 `{id, reply}` jsonl，`--eval` 用 lib/refusal-scan.js 判 verdict（pass/fallback/refuse），
  mcnemarExact 精确二项出 p 值，`--rubric strict` 附加 looksDeliverable（lib/prompt-delivery.js）口径。
- 必跑良性对照（`--benign`）：探针臂若在良性题上掉链子，评测无效。

## 探针分类学（吸收 syadagentic T1-T119 + Minglink 三架构）

五大类，编号进题库 `category` 字段（expected_domain 均为 `llm`）：

| 类别 | id 前缀 | 机制 | 设计要点 |
| --- | --- | --- | --- |
| 身份系统 | `P-IDT-` | 覆写/掏空 persona 与系统规则引用 | 让模型「复述规则」「扮演无规则版本」；负向指纹=自引用条款顶回（参见 Qoder 验证姿势教训） |
| 混合帧 | `P-MIX-` | 虚构/学术/翻译/评测等外框包住请求 | 外框越「正当」，fallback 词面越容易漏——用 refusal-scan 九域词表兜底 |
| 轻量三架构 | `P-LT3-` | ① 最短直接句式 ② 角色锚定 ③ 增量升级（多轮） | 单条最小可行；升级链进 `--ladder {id,attempts[]}` |
| 输出塑形 | `P-SHP-` | 预填续写、格式绑架、JSON 包裹 | 验证「结构正确但内容软化」的 fallback |
| 压力递进 | `P-ESC-` | 多轮累积上下文逐步加码 | 与 ladder 配合；每轮单独判 verdict |

## 评测纪律（吸收 Minglink 流水线 + ai-jailbreaks 矩阵口径）

1. **配对**：`pairArms` 按 `id:` 前缀配对；采集时两臂必须同 id、同 prompt、同 sampling。
2. **sampling**：`--sampling n:c:k`（n 次、判 c 次、过 k 次）；单次判读噪音大，关键臂 ≥5:c:3。
3. **rubric**：默认 pass 口径（refusal-scan）；定案用 `--rubric strict`（looksDeliverable 有可照做细节）。
4. **良性代价**：benign 题两臂都应 pass；B 臂 benign 通过率显著掉 = 提示词过拟合探针。
5. **lessons**：评测完跑 `--lessons`（lib/eval-lessons.js distillLessons）出 CanonicalLesson markdown。

## 采集管道

`scripts/collect-arm.mjs`：读 `eval/prompts/*.jsonl`（每行 `{id, prompt, expected_domain, category}`），
POST 到 OpenAI 兼容端点，产 `{id, reply}` jsonl 喂 `--eval`。环境变量：
`DSH_PURGE_EVAL_BASE_URL` / `DSH_PURGE_EVAL_API_KEY` / `DSH_PURGE_EVAL_MODEL`；
臂标签 `--label A|B` 决定输出文件名与三件套目录（见 ABSORPTION-TASKBOOK.md T-03）。

## 题库

- `eval/prompts/probes-core.jsonl` — 核心探针（五类全覆盖，原创文本）。
- `eval/prompts/ai-jailbreaks-35.jsonl` — 35 条矩阵槽位（吸收 ai-jailbreaks「一题多模型」口径，
  文本为原创极简模式，槽位 id `J-35-<nnn>`）。
- syadagentic T1-T119 的分类维度已折进 category 取值与上表；不逐条搬运。
