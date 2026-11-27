# claude-style 模型按钮「选择模型」真凶（2026-11-25 定案）

## 现象链
- YG 报 composer 模型按钮（输入框下、回退旁）显示「选择模型」。官方 model-selection 包 #110 修复后探针证明官方按钮一直显示 Hy4 flash——YG 看的是另一处。
- DOM v2 探针抓全页按钮文本，找到「选择模型选择模型」双写按钮 → dsh-claude-style 插件的「重绘模型选择器」功能。

## 根因
- claude-style 自己从 modelDirectories.store 读 current 解析模型名，纯精确匹配（group.id===current.provider）。
- request-shape 的 *-purge 别名 provider 不在 groups 里 → 永远 MISS → fallbackLabel「选择模型」。
- 同一 store 两条解析路径：官方组件（#110 已修）与 claude-style（未修）——只修官方那条没用。

## 修复（#111 CLAUDE_STYLE_MODEL_ALIAS）
- 解析函数加三级匹配：双侧剥 -purge → 同 model id 全目录 → null。
- **压缩变量名每小版本换血**：0.22.1=M(h)、0.22.2=R(f)、0.22.3=k(f)、0.22.4=M(p)、web profile 0.19.3=p(c)。
  逐版枚举是打地鼠（11-25/11-26/11-27 连续三天被自动更新打回）。**2026-11-27 终局：#111 改用一条通用正则**
  `/function ([\w$]+)\(([a-z])\)\{if\(!\2\|\|\2\.current===null\)return null;(?!const _p=)[\s\S]*?\}\}return null\}/g`，
  用 `$1`/`$2` 捕获复用任意变量名，负向前瞻防重复消费。桌面+web 两 profile 各命中 1 次、node --check OK、
  引擎 applied→already 幂等；regexReplacements 9→10，npm test 523 全绿。以后再换变量名都不用改补丁。
- **斜杠事故（11-26）**：手写新形态时把 `.replace(/-purge$/,...)` 写漏闭合斜杠成 `/-purge$,`——正则不闭合，
  解析器把后面整段吞进正则体直到下一个 `/`（注释 `/*`），报 `Invalid regular expression: Unmatched )`。
  且 p(c) 形态当时就带着同款错误但从未落盘（web 面不洗）所以没暴露——**每条新 replacement 都要在临时副本上
  node --check 实证，不能因为「和上一条长得一样」就免检**。
- file 键 claude-style-client：profiles/{desktop,web}/node_modules/dsh-claude-style/lib/client.js。
- markers: ["[dsh-purge-111]"]；contract patches=105 withMarkers=104 optional=63；代码层 66→67；npm test 517 全绿。

## 引擎坑（这次实测）
- applyPatches 第一参数是 **aiBase** 不是 dshHome。传错会让 allowTargetPathForAiBase 走 else 分支 → desktop-profile 路径被过滤、只剩 web-profile。
- core.js 是 CRLF：python 处理锚串必须带 \r\n（newline='' 读入）。
- test/patch-contract.test.mjs 是 LF：改计数断言用 \n。
- 手打磁盘后引擎 status=already 的前提是 replace 串与手打产物逐字一致——先打磁盘再入库时，用引擎 write:true 跑一遍验证 already。

## 插件更新抹补丁（本次复发机制）
- claude-style 0.22.1→0.22.2（2026-11-25 08:42 自动更新）抹掉手工 110m → 按钮退回「选择模型」。
- 入库 dsh-purge 后启动/「应用」自动重打，复发闭环关闭。
