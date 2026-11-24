# DSH 桌面版模型选择器「请选择模型」退化修复（#110 补丁）

日期：2026-11-21
触发：YG 报告桌面版 DSH（宿主 0.2.2-rc.5，`D:\Program Files\DSH`）输入框下方的模型选择器在每轮对话后从模型名退化成「请选择模型」。

## 根因

`dsh-client-ui-model-selection/lib/client.js` 的 modelLabel 逻辑在目录（catalog）刷新后匹配不上当前选择时回退到 `trigger.fallback` 文案；分组与已保存选择都在，纯 UI 显示退化。rc.5 变更说明明确这是设计内行为（凭证缺失→空目录→隐藏分组；匹配不上→显示「请选择模型」，选择保持不变）。目录刷新事件源：`llm/adapters-updated` / `llm/models-updated` / `settings/document-updated` / `credentials/*-updated` / `connection/reset`。

## 补丁内容（两处，均在 client.js 内）

1. `const lastActionRef=(0,react.useRef)(`load`);` → 追加 `const lastLabelRef=(0,react.useRef)(null);`
2. `const waiting=currentChoice===void 0&&state.status===`loading`;const modelLabel=waiting?t(`trigger.loading`):currentChoice?.model.name??t(`trigger.fallback`);` → 改为 hasCurrent/resolvedLabel 结构：hasCurrent 时写 lastLabelRef，失配时显示 `lastLabelRef.current ?? t(`trigger.fallback`)`。

## 关键路径事实

- 桌面宿主真正加载的文件：`D:\Program Files\DSH\resources\app\dsh\node_modules\@deepseek-ai\dsh-client-ui-model-selection\lib\client.js`（宿主从 resources/app 目录跑，非 asar）。全盘唯一在役拷贝。
- `desktop-runtime.json` 的 files 清单（逐文件 sha256）在宿主 main.js 的 `readDesktopRuntime` 两个调用点（`main.js:11512` applyRelease、`:21808` 版本读出）都只消费 `release` 字段——**没有启动时逐文件哈希校验**，改 runtime node_modules 下的文件不会被拦或自动还原。
- dsh-purge 已入库为 **#110 MODEL_TRIGGER_LABEL_KEEP**（`lib/core.js`）：目标键 `model-selection-client`（targetFiles 里 `nestedPkg(aiBase, "dsh-client-ui-model-selection", "lib", "client.js")`），optional + skipIfMarked + `markers: ["[dsh-purge-110]"]` + 每条 replacement `expect: 1`。
- 契约测试三处数字同步：withMarkers 102→103、optional 61→62、代码层 65→66；desktop-only 表保持 11（#110 不声明 surfaces）。
- `npm run contract` 重新生成 `test/patch-contract.json` 后 `npm test` 462 全绿。

## 写盘路径语义（重要，和 conversation-client 同型）

`applyPatches` 的 `preserveClientBundles=true` 分支（启动自愈 settle）对 `isWatchedClientBundle`（`*/lib/client.js`）**只判状态不写盘**：settled→already；pattern 还在→notFound（rollup 成 pattern_not_found，optional 软成功不挡 Apply）。真正落盘要走 `preserveClientBundles=false` 的应用路径（GUI「应用」/ `dsh-purge apply` / reapplyInstalled 官方升级链 freshExtract）。所以官方升级抹掉 #110 后：启动自愈报 pending 提示有活，落盘要等下一次「应用」动作。

## 宿主枚举注意

`enumeratePatchAiBases` 会同时命中 `D:\hrh\dsh\node_modules\@deepseek-ai`（开发副本，无该包 → hit_count_mismatch 0/1，optional 不挡）与桌面安装目录（applied）。

## 宿主文件现状态（2026-11-21 17:30）

- 62,345B，带 `[dsh-purge-110]` 标记，`node --check` 通过。
- 官方原件备份：同目录 `client.js.dshpurge.bak`（61,983B）；手工补丁时代备份 `client.js.bak-20261121-modelkeep`（内容=官方原件）仍在。
- `patchStatus #110 = applied`。
- 需要重启桌面版 DSH 生效（renderer 启动时加载）。
- dsh-purge 改动（core.js + contract.json + contract.test.mjs，+77/−5）未提交，等 YG 决定。

## v2 升级（2026-11-23）：groups 全目录兜底解析
- 「重启后仍显示请选择模型」排查定案：服务端服务的**就是补丁版**。`/plugins` 路由不带认证（dsh-client-modules 直接 register prefix /plugins），combo URL `/plugins/??<id>/client.js&rev=<rev>`，rev=`framedHash('plugin-artifact',[mtimeMs,ctimeMs,size])` sha1 前 12 位——**不是内容哈希**（修正 v1 时的错误结论）。本地算 rev 后 curl 实测服务字节含补丁原文。Code Cache 里无 lastLabelRef 的旧缓存文件只是没被重编译的陈旧产物，不作数。
- 真根因：v1 补丁的 lastLabelRef 只在某次渲染 `currentChoice!==void 0` 时写入；YG 场景是**已保存选择从会话打开起就不在 choices 里**（choices=groups.flatMap，目录快照不含该选择），实例从未成功解析 → lastLabelRef=null → 永远 fallback。rc.5 设计内回退。
- v2 修法：失配分支追加 `state.groups.find(g=>g.id===state.current?.provider)?.models.find(m=>m.id===state.current?.model)?.name` 兜底，找到即显示真实模型名并写 lastLabelRef（防后续目录真变空再退化）。waiting 分支不动。
- 验证：临时副本替换→node --check→落盘→本地算新 rev（cff11f5cefe6，size 62741）→curl 运行中宿主 54116 →服务字节含 groups-resolve（HTTP 200，62806B=盘上62741+65 combo 包装）→client-hmr 500ms 轮询自动换新 rev，**运行中页面无需重启即生效**。
- dsh-purge #110 条目 replace 同步 v2；npm run contract（patches=104 withMarkers=103 optional=62）+ npm test 462 全绿；applyPatches(write:false) 对桌面宿主基 status=already。
- 排查工具链坑：cygpath -w 结果给 node --check 时若经变量展开丢引号会 MODULE_NOT_FOUND，直接用 D:/ 正斜杠全路径最稳；MSYS /tmp 下 node 读不到（映射 D:\\tmp），统一 cygpath 换算。

## v3 升级（2026-11-23 下午）：真根因 = `-purge` 别名 provider 失配
- YG 复测仍退化（session-670721cf 切走切回即「请选择模型」）。追会话数据：`storages/session_projcache/sessions/session-670721cf-*.json` 的 `record.rows.modelSelection.val.lastUsed = {provider:"workbuddy-purge", model:"hy4flash-free"}`。
- `workbuddy-purge` 是 request-shape.js 的请求别名（lib/request-shape.js `installRequestShape`，`${provider}-purge`，agent/request hook **惰性注册**，`llm.registerAdapter([alias], proxy)`）；`aliasInCatalog` 默认 false（lib/index.js:113）→ UI 目录 groups 只有源 provider `workbuddy`。会话存的选择带 `-purge` → `currentChoice` findIndex 永久失配 → 永久 fallback。usage.sqlite 佐证：calls 表有 zi-purge/qoder-purge/workbuddy-purge/workbuddy-global-purge 等一整族，workbuddy-purge/hy4flash-free 1305 次最新到当天。
- v3 修法：findIndex 行加 `purgeAliasProvider=provider=>String(provider??``).replace(/-purge$/,``)`，比较双侧剥后缀（与 #96 的 routeProvider 同一判定）；v2 的 groups 兜底解析同步剥后缀。别名选择直接映射回源 provider 目录条目，`renderModelLabel` 显示真实模型名。发消息时 request-shape hook 的 isOwnAlias 分支会自动补注册别名，路由不受影响。
- 落地坑：bundle 里该行带 `const ` 前缀，pattern 漏前缀会替换出 `const const` 语法错误——第一次临时副本 node --check 抓到后修正。v3 实际替换两处 + v2 行升级，size 62,931B，标记 3 处，rev 3cfd8acd626d，curl 运行中 54116 已服务含 purgeAliasProvider×4 的字节。
- dsh-purge #110 现为 3 条 replacement；npm test 462 全绿；applyPatches(write:false) 对桌面宿主 status=already。
