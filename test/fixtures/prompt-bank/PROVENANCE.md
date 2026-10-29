# 评测样本来源 / Provenance

本目录的 `.jsonl` 文件**不是** dsh-purge 自己写的，是从 maodie-purge 原样复制的评测用例。

| 文件 | 字节 | 用例数 | 来源 |
| --- | --- | --- | --- |
| `prompt-bank.jsonl` | 7192 | 见文件 | `maodie-purge/tests/prompt-bank.jsonl` |
| `prompt-bank-maodie.jsonl` | 5777 | 见文件 | `maodie-purge/tests/prompt-bank-maodie.jsonl` |
| `prompt-bank-mirror.jsonl` | 5196 | 见文件 | `maodie-purge/tests/prompt-bank-mirror.jsonl` |
| `v4pro-benchmark.jsonl` | 7892 | 见文件 | `maodie-purge/tests/v4pro-benchmark.jsonl` |

合计 110 条，覆盖 web / game / llm / crack / re / mobile / network / cloud /
miniprogram / postex / generic 十一域，中英双语，长短混杂。

## 上游

- 项目：`Maodie-purge` v2.0.0
- 上游仓库：`https://github.com/Wei0417-top/Maodie-purge`（HEAD `d7b05dc`）
- 改编自：`Minglink/dsh-infinite-gen-4`
- 许可：**CC BY-NC-SA 4.0**（署名 — 非商业性使用 — 相同方式共享）

## 在 dsh-purge 里的用途

**只作为测试夹具，不进入运行时。** 具体是两件事：

1. `test/prompt-bank-routing.test.mjs` 用这 110 条固定叶子路由的召回率 ——
   93 条带攻击域标签的用例必须 100% 命中至少一片叶子。这是「按需注入没有
   悄悄退化成全文注入」的回归线。
2. `lib/prompt-bank.js` 提供解析（跳过空行与 `#` 注释，坏行计数不抛异常）。

**不参与任何提示词、补丁、注入内容的生成。** 运行时读的是
`prompt-inject.md` 与 `lib/rules.js`，与本目录无关；删掉本目录，插件行为不变，
只有这两个测试会失败。

## 许可合规

- 非商业性使用：dsh-purge 自身不随附这些用例的商业分发；若你要在商业场景
  使用本仓库，请先移除本目录并删掉 `test/prompt-bank-routing.test.mjs`。
- 相同方式共享：本目录内容保持原样（字节级 `Copy-Item`，未做任何改写）。
- 署名：见上表与本节。

若上游更新用例，重跑一次复制即可，不要在本地编辑这些文件 —— 改了就不再是
「别人写的用例」，回归线也就失去意义。
