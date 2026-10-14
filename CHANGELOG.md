# Changelog

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.0-alpha.3] - 2026-10-13

**用量明细页落地：两级下钻（厂商 → 模型），并把账本读取真正接通。**

本版全部围绕设置页里那个「模型用量明细」。它此前根本显示不出来，
修好之后又暴露出一批统计口径与布局问题。

### 新增

- **两级下钻**：第一层按 **provider id** 统计（调用数 / token / 耗时 / 失败数 /
  成功率），点进某厂商后第二层把**该厂商的模型卡片**、**请求明细**、**时间线**
  三段平铺，且全部限定在该厂商内。
  两层各自回答一个问题：厂商层答「哪家在拖后腿」，模型层答「这家该用哪个」。
- **provider id 不按供应商归并**（明确决定，非遗漏）：`qoder` 与 `dsh-provider-qoder`、
  `workbuddy` 与 `workbuddy-global` 虽同属一家，但是不同接入通道，
  通道间成功率差异本身就是信号（workbuddy 100% vs workbuddy-global 93%），归并会抹掉它。
- **汇总改用行卡片**，取代密集表格：每行「用量条 + 调用 / token / 耗时 / 失败 / 成功率」，
  点击展开平均耗时、平均 token、主要错误码、首次与最近使用时间。
- **成功率三档色阶**（绿 ≥90% / 黄 ≥60% / 红 <60%），用量条同色，一眼定位异常厂商。
- **错误码分布统计**：逐码计数并取前二显示在展开区（真实数据里 `RATE_LIMIT×228`
  占某厂商失败数的绝大多数）。
- **明细表新增首字延迟与会话列**，可按会话定位具体请求。

### 修复

- **设置页内容空白**：`settings.section` 的契约只声明 `id`/`order`/`label`，
  组件必须作为 `slots.register` 的**第二个参数**传入；写成 `{ render }` 会被静默忽略，
  表现为左侧导航有条目、右侧一片空白。
- **整节被宿主卸载**：`apply` 顶层误引用了只在组件作用域内定义的 RPC 取件器，
  抛 `ReferenceError` 后宿主把**整个** `settings.section` 摘掉（不止本插件那一项）。
  现改为在 `apply` 作用域内 `resolveSettingsRpc(ctx)` 经闭包传入；测试锁定该函数名
  在全文只出现一次，防止回归。
- **快照读不到**：`/api` 是**单一共享** `rpc.intercept` 拦截器，已被
  `dsh-tool-antigravity` 占用，挂上去不触发。改用
  `connection.fetch.register({ path: '/api/model-picker-plus-usage/snapshot' })`
  注册**精确 Fetch 路由**（官方插件同款），多方共存且复用宿主 origin/认证/peer 准入。
- **token 列全是破折号**：账本按 `inputTokens`/`outputTokens`/`cacheReadTokens`/
  `cacheWriteTokens` 分桶存储，**没有** `totalTokens` 字段。新增 `totalTokensOf()`
  按桶求和（优先采信上游给出的 `totalTokens`），与 host 侧 `totalOf()` 同口径。
- **统计遇损坏行整页崩**：JSONL 可能解析出 `null` 或原始值，`r.provider` 直接抛。
  现跳过非对象行与缺 provider/model 的行。
- **工具栏胶囊被压成竖排单字**（截图里「明细」拆成上下两个字）：6 个胶囊挤在同一个
  不换行的 flex 容器里。改为排序组与筛选组各自独立容器 + 外层 `flexWrap: 'wrap'`
  + 胶囊 `whiteSpace: 'nowrap'`，并抽成 `chip()` / `toolbar()` 构件供两层复用。
- **状态列被裁成 `RATE_L`**：列被内容撑破且 `nowrap` 无省略。改为
  `maxWidth` + `textOverflow: 'ellipsis'`、容器横向可滚、完整错误码放 `title`。
- **`formatTokens(0)` 返回空串**导致整轮全失败的模型渲染出空白格。补 `'0'` / `'—'` 兜底。
- **警示色缺失**：主题未提供 warning token 时三档色阶会塌成文字色。
  改用 `var(--dsw-alias-state-warning-primary, #d9a441)` 带回退。

### 验证

- 四级测试套件全绿（`node --check` ×2 + client / host-usage / host-apply / host-client-wiring）。
- **用真实账本跑发布的聚合代码**（`preview/real-check.mjs`）而非只读代码：
  厂商层与模型层在调用数与 token 上完全对账。该轮跑出的数字纠正了我手写在设计稿里的
  两处错误（`workbuddy-global` 实为 152.8M 而非 195.1M —— 发布路径按 `usageReported`
  过滤；平均 token 按上报样本数而非成功数除）。
- 设计稿先行并经用户确认后才动代码：`preview/prototype.html`（静态原型，
  数字取自真实账本，`preview/agg.mjs` 为推导脚本）。

### 已知局限

- 用量徽标只匹配**真实模型 id**：WorkBuddy 网关的别名（`auto`/`fast`/`balanced`/
  `primary`）不会显示，因为账本记的是路由后的真实模型名。
- 快照单次上限 500 条，超出的历史不进入统计（账本本身完整保留）。

## [0.6.0-alpha.2] - 2026-10-12

**逐请求使用账本：接通真实 RPC，并修正两处会算错数的逻辑。**

0.6.0-alpha.1 只做到「账本能写」，但界面读不到——那条链路当时是假的（client 同步
调用一个从未注册的 remote 服务，测试里也是模拟的）。本版把它做实。

### 修复

- **采集入口拆成独立插件**（`dsh-model-picker-plus/usage`）。此前采集逻辑挂在包根，
  而包根同时承担 Client 半边：根一缺依赖就整个挂不上，Client 也跟着失效。
  现在根保持 no-op，采集是 `cordis.patch.yml` 里独立一行，依赖声明互不牵连。
- **界面读取改走真实 Connection RPC**：client 端改为**异步**读取并支持 `AbortSignal`
  （菜单关闭即取消，不留悬挂请求）。
  <!-- 本节原先写的是 host 用 `connection.rpc.intercept('/api', ...)` 注册路由，
       那是错的：/api 是**单一共享拦截器**，已被 dsh-tool-antigravity 占用，我们
       挂上去根本不触发。最终方案见 0.6.0-alpha.2 补充段（fetch.register 精确路由），
       已在 0.6.0-alpha.3 一并说明。保留这段注释是为了不再有人把 intercept 当解法。 -->
- **去重不再靠 token 指纹**：旧版用「provider|model|各 token 数」判定重复，
  会把**用量恰好相同的两次真实调用**误删。现在每条记录带唯一 `requestId`，
  只有同一个 requestId 才去重；相同 token 数的不同请求照常记录。
- **不再双路记账**：同一调用原本会被 `llm/stream` 与 `session/event` 各记一次。
  现在只以 `llm/stream` 为准（带精确耗时），彻底消除重复来源。
- **token 合计口径**：`reasoningTokens` 是 `outputTokens` 的子集，旧口径会把它再加一遍
  导致总量偏大。现在优先采用上游 `totalTokens`，否则按 input+output+cache 求和，
  并标记该合计是否精确（缺字段时为非精确，界面据此不冒充精确值）。
- **轮转不再删历史**：旧版超过阈值会把账本重命名为 `.1` 并**覆盖**已有归档。
  现在归档名带时间戳与随机串，历史只增不减；且写入前补齐撕裂的尾行，
  损坏行不会吞掉后续记录。

### 新增

- **逐请求唯一 ID 与精确耗时**：每条记录含 `requestId`、`durationMs`、
  `timeToFirstTokenMs`（首字节延迟）与 `timezoneOffsetMinutes`（便于按时段分析）。
- **采集状态可见**：快照带 `status.collecting` / `persistedCalls` / `writeErrors` /
  `recordCount`，界面可判定「尚未开始采集」而不是把空账本显示成「用了 0 次」。
- **隐私边界明确**：账本只存归属、时间、用量与结束状态，**绝不落盘**提示词、
  响应正文或凭据；失败记录只保留错误码与 HTTP 状态，不复制原始 message
  （它可能内嵌请求体）。测试里有对应断言。

### 已知局限

- 采集从启用时开始，**此前的历史用量无法补录**（宿主不提供按模型的历史查询）。
- 官方 `tokenUsage` 投影是**会话级总量**，不带 provider/model 维度，
  因此按模型拆分只能靠本插件自己记账。

## [0.6.0-alpha.1] - 2026-10-10

**逐请求的 LLM 使用账本（host 侧）** —— 新增能力，尚待真实环境验证，故走 alpha 通道。

### 新增

- **host 侧逐请求记账**：订阅宿主的 `llm/stream` waterfall，在**每一次**流式模型调用外层记录一条明细，
  覆盖主对话、子代理、压缩（compaction）与标题生成等全部调用。
- **记录的字段**（每次请求一条）：
  - 归属：`provider`、`model`、`sessionId`、`purpose`
  - 时间：`startedAt`、`endedAt`、`durationMs`（用于响应耗时统计与按时段分析）
  - 用量：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、
    `reasoningTokens`、`totalTokens`（全部来自上游上报，缺失时**不编造 0**）
  - 状态：`finishKind`（stop / tool-calls / max-tokens / error / aborted）、`ok`、
    失败时的 `error.message` / `code` / `status`
- **落盘为 JSONL**（每请求一行追加）：崩溃最多丢最后一行，不会像整体重写 JSON 那样
  写坏已有历史；超过 8MB 自动轮转一份 `.1`。
- **client 侧展示与排序**（本轮补齐，数据链路已端到端打通）：
  - `readUsageIndex` 经 remote 取 host 的 `summarize()` 汇总；兼容直返与
    `{ ok, value }` 两种 RPC 形态。取不到一律返回 `null` —— 界面不显示用量，
    **绝不退化成「0 次」**（没数据 ≠ 用了零次）。
  - `UsagePill` 在模型行右侧渲染中性灰用量胶囊（`N 次调用 · 1.5M tok`），
    hover 显示成功/失败次数、token 与累计耗时。刻意不占用 `CAP_TONES` 的能力色，
    避免「颜色 = 能力」的误读。
  - 排序维度切换：默认 / 按调用次数 / 按 token 量 / 按耗时，
    仅在「最近使用」「收藏」列表生效（按用量重排这两张清单最有意义）。
  - 无账本数据时整组排序控件隐藏 —— 排不出差异，点了等于没反应。
  - 稳定排序：无用量记录的行沉底且保持原相对顺序，位置不会因排序抖动。

### 设计说明

统计必须放在 host 侧：client（`platform: web`）订阅不到宿主的 `llm/stream` 事件，
拿不到 provider/model 归属与上游上报的精确 token。因此本包改为双端协作——
`index.js` 负责收集，`client.js` 负责展示。

### 修复

- **host 侧从未真正挂载**（本次最关键的一处，连续三次才定位到）：
  账本目录会被创建，却一条账都没记。**加载探针（`loaded.marker`）把两种原因
  一刀切开**：探针有、账本空 → 模块加载了但服务没实例化；探针都没有 → 模块压根没加载。
  根因是插件注册形态不对，连踩三次：
  1. `export const inject = {...}` + `export function apply()` —— 加载器不认这个形状；
  2. 改成 `export default createUsageService`（工厂）—— 加载器执行
     `exports = exports.default ?? exports` 后把结果当**服务类**，拿到的是
     「造类的函数」，实例化失败；
  3. `export default class ... extends resolveServiceBase()` —— 但
     `resolveServiceBase()` 拿不到真基类：`@deepseek-ai/cordis` **不在 profile 的
     node_modules 里**（只存在于 app.asar 内部），`createRequire` 同样解析不到，
     于是静默退化成普通类 —— 类能 `new` 但缺 fiber/ctx 注入，构造函数里的订阅挂不上。
  终解：`default` 导出类本身，基类优先从 `ctx`（加载器自己的可达路径）解析，
  再退回 `createRequire`，最后才退化。官方 `dsh-token-meter` 直接
  `export default class extends Service`，是同一套约定。
  新增回归测试锁住三点：`default` 是构造函数、带静态 `inject`、可被 `new` 实例化。
- **多帧 usage 合并丢字段**：归一化时写出显式 `undefined` 键，后一帧的
  `undefined` 覆盖了前一帧已有的值，表现为「上报越多次、token 反而越少」。
  改为只有真正拿到数值才写键。
- **组件状态序号漂移**：新增两个 `useState` 后，测试里硬编码的状态序号整体错位，
  思考档位面板的两条断言因此失败。已同步序号并加注释说明该序号与
  `useState` 调用顺序绑定。

### 测试

四套共覆盖记账、聚合、跨端链路与 UI 渲染：

- `tests/host-usage.mjs` —— 归一化、透传、边界（异常/截断/多帧合并）、落盘与聚合
- `tests/host-apply.mjs` —— `apply()` 订阅、端到端落盘、汇总暴露、降级路径
- `tests/host-client-wiring.mjs` —— **跨端链路**：host `summarize()` → client 读取器
  （直返 / 包壳 / 报错 / 抛错四种形态）
- `tests/client.mjs` —— 原有 UI 用例 + 用量格式化、三维排序、胶囊渲染

### 已知局限

- 账本目录优先取 DSH 数据目录，退回 `~/.dsh/dsh-model-picker-plus`；
  若宿主的 storage 服务不在位，会落到后者（仍可持久化）。
- 官方 `tokenMeter` 是**会话级累计**，不带 provider/model 维度，
  所以按模型拆分只能靠本插件自己记账；两者不会重复计数（口径不同：本插件按请求条数）。
- 本版本为 alpha，字段结构在验证后可能调整。

## [0.5.0] - 2026-10-09

相对 npm 上的 0.3.1，本次累积了多项功能与修复，故按「新增功能」升次版本号（`0.3.1 → 0.5.0`）。

### 新增

- **思考档位可见与快捷切换**
  - 列表里可切换档位的模型，标题旁显示档位胶囊（如 `High`、`思考 5 档`），一眼看出「点它可调强度」。
  - 触发条上的档位文字（如 `· Xhigh`）变为可点入口，就地弹出档位列表，不必进大菜单翻「当前」卡片。
  - 档位面板走 Portal 渲染到 `body`，避开触发条与输入栏祖先的 `overflow` 裁切。
  - 打开档位面板时自动收起大菜单，两层面板不再互相遮挡。

- **厂家标签双行流式布局**
  - 厂家标签紧接「全部模型」之后流式排布，不再另起一块。
  - 两行按**实测宽度**填满后才折叠，剩余厂家由「更多 N」承接，绝不静默裁掉。
  - 「更多 N」内联在最后一个厂家之后，不推到行尾留白。
  - 宽度用 `getBoundingClientRect` 真实测量，而非字体估算——估算偏保守会白扔容器容量。

- **厂家按使用频次排序**
  - 首次使用无记录时完全保持目录默认顺序，不打乱既有习惯。
  - 之后按**成功回复的消息数**降序，常用的自动浮到前面，不必去末尾翻。
  - 同频次保持目录相对顺序（稳定排序），标签位置不会莫名跳动。
  - 计数口径是「回合跑完」而非「切换模型」：切换只是选中，反复点选不代表在用。

- **能力标记与品牌图标**
  - 混元新系列（`hy3` / `hy4-preview`）正确解析到混元品牌图标，不再退化成字母 `H`。
  - 可切换档位的模型不再重复挂「推理」胶囊（与档位胶囊语义重叠）。

### 修复

- **厂家免费徽标误标**：构建期元数据快照按裸 id 跨厂家合并，导致官方付费渠道
  （如 `deepseek-v4-pro`）被同名免费条目的零价记录传染，误挂「免费」胶囊。
  现在快照的 `f` 位不再单独作为免费证据，必须与 free 语境（`free-` 前缀 /
  `:free` 后缀）同时成立；全库误标从 426 条降到 80 条。
- **视觉能力被快照一票否决**：models.dev 对大量模型只登记文本输入（743/2315 条
  无 `i` 字段），旧逻辑会据此把模型判成「非视觉」，连名字里的 `vision` 都不看。
  现在快照只提供**正向的额外模态**，不再具备否决权；endpoint 的显式声明仍有否决权。
- **指令微调模型被误标推理**：去掉了描述关键词兜底（`Mistral-7B-Instruct` 这类
  模型的描述常含 reasoning 字样），改为只认结构化证据。
- **「更多」点了没反应**：展开态与折叠态曾共用同一套装箱，算出的折叠数恒等于
  折叠态，点击后界面毫无变化。现在展开态完全绕开折叠，全部厂家可见。
- **展开后厂家被裁掉**：旧版用 `nowrap + overflow:hidden` 裁切溢出内容，
  用户看不到被折叠的厂家。现在容器允许换行，折叠由装箱算法决定而非 CSS 裁切。
- **思考档位计数占位符**：`{count}` 曾被原样渲染到胶囊上（`t()` 只接受 key、
  不做插值），改用 `fill()` 完成插值。

### 已知局限

- **厂家使用频次只在打开模型选择器时结算**（打开时立刻结算一次，菜单保持
  打开则每秒轮询一次，关闭即停）。若长时间不打开菜单，期间跑完的轮次可能漏计。
  这是为了避免后台常驻定时器而做的取舍。

## [0.3.1] - 2026-09-23

- npm 上的历史版本，本 changelog 建立前的最后一次公开发布。

[0.5.0]: https://github.com/objectyan/dsh-model-picker-plus/releases/tag/v0.5.0
[0.3.1]: https://github.com/objectyan/dsh-model-picker-plus/releases/tag/v0.3.1
