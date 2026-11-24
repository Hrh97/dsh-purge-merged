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

## v3b（2026-11-24）：「又出现」排查——补丁没被还原
- YG 报「又出现，看看是不是修改被还原了」。核查结论：**没有还原**。磁盘 client.js 62,931B→v3b 63,013B，dsh-purge-110 标记在、purgeAliasProvider 4 处在；宿主 11-24 10:49 重启（端口 54116→54524，PID 52744），重启后 `/plugins` 与 relay 域名（e483c6400a987634.dsh-market.com）都在服务补丁版字节；旧 rev URL 已 404（缓存旧 URL 的页面刷新后会重新拿新 rev，不会跑旧代码）。无 .pnpm 第二副本。
- 近期会话 modelSelection 全是 `*-purge` 别名（workbuddy-purge / workbuddy-global-purge / zi-purge / minimax-purge / raccoon-purge）→ v3 剥后缀逻辑单测命中（workbuddy-purge→workbuddy 组；workbuddy-global-purge→源组 workbuddy-global 需目录里存在）。
- v3b 动作：加 `window.__dshPurge110` 计数痕迹（组件每次渲染 +1），DevTools console 可查是否在跑补丁版。落盘后 rev 93b0a4244e88，服务端 HTTP 200 已带痕迹。#110 repl3 同步并入痕迹行；npm test 495 pass（含 trace 依赖更新）。
- 若 YG 复测仍退化：让他在该会话按 Ctrl+Shift+I → Console 输入 `window.__dshPurge110`——有数字=补丁在跑（往数据面查）；undefined=页面没在跑这份 bundle（往加载面查，硬刷新 Ctrl+R）。

## v3b 的 `__dshPurge110` 痕迹已摘除（2026-11-24 金鱼审查 H2）
- 上面 v3b 加的那行 `if(typeof window!==\`undefined\`){window.__dshPurge110=(window.__dshPurge110??0)+1;}` 是**临时排查痕迹**，一直留在 #110 的 replace 正文里、且未提交。桌面 profile 以符号链接指向本仓库，重启就会把它写进活宿主的 `dsh-client-ui-model-selection/lib/client.js` —— 调试计数器不该进生产补丁产物。
- 处理：从 `lib/core.js` 的 #110 repl3 replace 里删掉该行，并从活宿主 client.js 剥掉已泄漏的 82 字符（备份 `/tmp/host-client-backup.js`）。`--apply` 后宿主三处 marker（`[dsh-purge-110a/b/c]`）在位、`node --check` 通过。
- **下次要复测这个补丁，别改 replace 正文** —— `scripts/gen-patch-contract.mjs` 只锁 marker / pattern / replacement 长度，不锁 replace 正文，手改正文契约测试照样绿（这次就是这么漏出去的）。要临时观察就在 DevTools 里读 `document.querySelector` 的 React 树，或者另开一次性脚本打临时副本。

## v4（2026-11-24 下午）：v3 剥后缀仍会 MISS——跨区 model-id 兜底
- YG 报 `window.__dshPurge110` = undefined。复盘：**页面确实在跑补丁版**（v3），但 v3 没有 window 痕迹——undefined 只说明跑的不是 v3b。
- 真相分两层：
  1. **宿主文件被回写**：11-24 上午我手工落盘 v3b（含痕迹），但当天 YG 走了 GUI「应用」（freshExtract 链）→ 还原官方原件 → 按 core.js #110（当时是 v3 形态）重打 → 磁盘变回 v3（无痕迹）。手工改宿主文件必须同步 core.js，否则一次「应用」就洗掉。这层是流程教训。
  2. **v3 语义洞**：`workbuddy-purge` 剥后缀映射到 `workbuddy`（cn 组），但 hy4flash-free 实际登记在 workbuddy-global 组（模型目录是运行时从上游拉的，磁盘源码无静态定义）→ findIndex 仍 MISS → 依旧「请选择模型」。
- SSE 决定性证据：`/plugins/events` 初始 snapshot 里 model-selection 的 rev=ea6c6142ee15，curl 该 rev 的字节只有 v3（无 `__dshPurge110`）——服务端服务的就是页面在跑的，闭环。
- v4 修法：findIndex 失配后逐级兜底——②同 model id 任意目录条目 → ③model.name === 存的 model。显示层兜底，不改路由。四场景单测过（alias 直配 / 跨区 id 兜底 / 未知 MISS / name 兜底）。
- markers 语义修：**markers 只列终态** [a,b,d]；c（rep4 归一产物）是瞬时态、立刻被 rep6 消费成 d。c 进 markers 会让 patchPartiallyMarked 对已打全文件永远假阳性（3/4 在场→拒绝软结算→假 drifted）。
- 验证手段升级：`/plugins/events` SSE 的初始 graph snapshot 是免认证的——能直接读到宿主当前认的每包 rev，比本地算 rev 可靠（rev 算法细节我此前复刻有出入：本地 framedHash 算的 93b0a4244e88 ≠ 宿主认的 ea6c6142ee15，但 URL 里 rev 只是键，curl 服务端认的 rev 拿到的字节才是页面拿到的字节）。
- 手工 patch 宿主 client.js 的标准流程（教训固化）：先改 core.js #N → npm run contract → npm test → 用补丁引擎 apply 落盘（而不是 sed/cp 手改）→ curl 服务端 rev 验字节。手改绕过引擎的结果就是被下一次「应用」洗掉。

## v5（2026-11-24 晚）：「切走再切回就退化」的真根因——resolve 段数据面修复
- YG 复现：session-2ae1bf1d 一开始显示正常，切走再切回 → 又变「请选择模型」。v4 的 findIndex 三级兜底修的是「current 有值但 choices 失配」；这次连 current 本身就是错的。
- 数据链定案：
  - 会话 modelSelection projection schema = `{lastUsed, next}`（dsh-api-session-controller/typert.host.js）。next=用户手动选的下一步选择；lastUsed=最近请求用的（request-shape 别名写这里）。
  - 该会话存档 val={lastUsed:{workbuddy-purge,hy4flash-free}, pending:null}——**没有 next 字段**（undefined）。
  - ModelDirectory.resolve（bundle 内）：`const selection=projected.next??catalog.value.default` → 切回会话时 next 未恢复 → selection=全局 default。
  - 全局 default=**grok/grok-4.7**（bot/state.json，YG 某次手动选模型时 selectModel→saveSelection 存的）。
  - 但 GUI 会话目录 groups 里**没有 grok 组**（grok 是 bot 线 adapter）→ routable=false、findIndex MISS、groups 解析 MISS → fallback。
  - 「一开始有显示」=打开会话时 projected.next 短暂有值（宿主 unit 从 agent 初始化）；切走再切回 unit 重建，projection 回放只有 lastUsed → 落 default → 必 MISS。
- v5 修法（resolve 段数据面）：selection 不可路由且 lastUsed 存在且≠selection 时，三级匹配 lastUsed（原 id → 剥 -purge → 仅 model id 全目录），命中则 current=lastUsed。current 本身变成可解析的真实选择，下游 findIndex/effort/高亮自然命中。routable/state.routable 在 rc.5 无其它消费者，改值安全。
- 六场景单测过（/d/hrh/tmp-audit/v5-resolve-test.mjs）：YG 场景回落 / next 可路由不动 / default 可路由不动 / 剥后缀命中 / 未知模型保 default / 同值不循环。
- core.js #110 加 rep7（v4→v5，marker 110e），markers 终态=[a,b,d,e]；npm test 499 全绿；引擎落盘 applied，SSE 新 rev=756819aeed95 服务字节已含 110e。
- 坑：node 写 '/tmp/...' 落到 **D:\tmp**（进程盘符解析），MSYS /tmp 是另一处——跨工具传文件路径用绝对 D:/ 或先 cygpath 对齐。

## v5c/v5d（2026-11-24 深夜）：自主探针定案——三个根因层级 + 110h 括号事故全解
- YG 报「控制台很多报错、__dshPurge110Data 空」→ 自主验证路线：bundle 里插错误钩子（error/unhandledrejection/console.error → no-cors GET http://127.0.0.1:59999）+ resolve 段每 3s 上报 {sel,rt,last,next,gn}。收集器：D:\hrh\tmp-audit\err-collector2.mjs（job bash-e4d2dbea44864953，端口 59999）。
- 探针数据推翻两个假设：①next 不是 undefined——它有值且=lastUsed（workbuddy-purge/hy4flash-free），v5 的 lastUsed 兜底条件 last!==selection 恒 false 不触发；②页面零运行时错误（YG 看到的报错是别的窗口的）。
- sel=workbuddy-purge/hy4flash-free 在 v4 findIndex ②（按 model id 全目录）也 MISS → 决定性推论：**运行时目录 gn=22 组里根本没有 hy4flash-free 条目**。
- groups dump 拿法一波三折（110h 括号事故）：fetch POST 版我数错括号（5 个 ) 应为 4）→ 宿主语法闸门拦截回滚，且回滚的现场本身就是坏的 → 手修 → 引擎 rep10 pattern 与手修产物不一致 → 引擎再写再拦截，最终磁盘回到 110g。**教训：改 bundle 长串必须独立 .mjs 脚本 + 程序化括号配平 + node --check 三关；core.js 里 replace 长串也要先配平**。
- 改用 **sendBeacon 分片版**（encodeURIComponent 每 1200 字符一片，k=grp&n=N）仍报语法错——最后发现根因不是括号数量（-1 报少、+1/+2 报多），是**表达式上下文里嵌 IIFE+try/catch+for 的结构问题**。改成**语句形态**（if(...){...try{}catch{}}）一次通过。教训：往压缩 bundle 插代码，插「语句」比往表达式链里塞「IIFE」稳得多——pattern 保留原 &&( 链（110g 形态），replace 用 `;if(...){...}` 接续。
- **cordis.patch.yml 里的 saved 目录（宿主设置持久化）**：`C:\Users\onemt\.dsh\profiles\desktop\cordis.patch.yml` 行 227 起 `dsh-connect-workbuddy.config.regions.{global,cn}.lastCatalog`——cn 区 lastCatalog **含 hy4flash-free（name: Hy4 flash）**、hy4std、hy4-flash-free-trial-202611、hy4flash、deepseek-v4.1-flash、glm-5.3、glm-5.3-flash 等；global 区是 fast/balanced/primary-model + hy4-preview + hy3。mergeRoster(saved, live)=live 优先 + saved 追加（workbuddy lib/index.js:171）→ 理论上合成目录应有 hy4flash-free。**UI gn=22 却没有 ⇒ 待 k=grp 回传比对**（hy4flash-free 被上游 roster 挤掉？还是 UI 目录根本不是这份合成？）。宿主重启后 GUI 端口会漂（58344→...），Harnessed 进程监听端口用 port-hunt.ps1 扫（ExecutionPolicy Bypass 必带）。
- 110h 已稳落盘（磁盘 node --check OK、引擎 status=applied、SSE rev=d7269eb7e08a、curl 服务字节含 sendBeacon×1、npm test 499 全绿）。等页面刷新后 k=grp 回传，一锤定音。
- **k=grp 已回传（2026-11-24 19:36 本地批，23 片重组成功 → `D:\hrh\tmp-audit\groups-dump.json`）**。重组法：collector 日志按 `n=0` 开新批 + 5s 毫秒窗聚合 + 分片数==maxN+1 校验后逐批尝试解析（同秒多批混流是主要干扰，切片必须先按 n=0 边界分组再拼）。**结论：运行时 UI 目录 22 组 281 模型里 hy4flash-free 并没有被挤掉** —— `workbuddy` 组完整含它（`["hy4std","hy4flash-free","hy4flash","deepseek-v4.1-flash","glm-5.3","glm-5.3-flash",...]` 15 模型），`workbuddy-global` 也有 hy4flash-free，`our-free-model` 组另有 `hy4-flash-free` / `opencode/hy4-flash-free` 变体。但 `k=data` 探针同窗口报 `sel=zi-purge/glm-5.3-flash`、`gn:22`、`rt:false` —— 即目录里**有** hy4flash-free 而解析段判定「不可路由」的是**另一个 provider 的 selection**（zi/glm-5.3-flash 当时 rt=false 属正常：模型在目录、路由由 provider 侧决定）。原始疑案（YG 报 sel=workbuddy-purge/hy4flash-free 找不到）发生时刻的 sel 快照已过窗（data 探针每 3s 滚动），无法回放；但「上游 roster 挤掉」假设被 19:36 的全量 dump **否证** —— saved 目录、live groups、mergeRoster 三层都有 hy4flash-free。若再复现，直接看 k=data 的 sel/rt/next 三元组即可，无需再拉 groups。
