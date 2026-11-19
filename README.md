## 功能

把 DSH 原生的扁平模型选择器换成一个可搜索、可分组的模型库——**只改模型下拉这一处**，其它界面不动。当前版本：`0.7.2`。

**左右两栏面板**
- **顶部全局检索条**：搜索框横跨两栏，搜模型名 / ID / 描述 / 厂家 / 用途，一处输入全局生效。
- **左导航 / 右列表**：固定视图（推荐 / 最近使用 / 收藏 / 全部模型）以 2×2 网格钉在导航顶部（sticky，不随滚动）；下方是**全部厂家**列表（一次列全，不再折叠成「更多 N」），点某个厂家，右栏只列该厂家的模型。
- **打开即定位当前厂商**：打开模型库默认落在当前选中模型所属的厂商页，不用每次从头找。
- **当前模型卡**：右栏顶部显示当前模型 / 厂家与思考档位（如 `High`、`思考 5 档`），就地切换不必翻菜单。选中带倍率 / 官方徽章的模型后，底部触发条也保留 `x0` 倍率芯片与「限时免费」徽章。

**搜索、筛选与收藏**
- **能力胶囊**：全部 / 免费 / 视觉 / 推理 / 工具，按 endpoint 声明与快照综合判定，命中才显示。
- **跨厂家搜索**：模型名 / ID / 描述 / 用途全字段检索。
- **收藏与最近使用**：置顶常用模型。
- **用量排序**：默认 / 按调用 / 按 token / 按耗时。

**官方功能自动同步**
- 面板自动渲染官方 `conversation.input.model.options` 子槽的所有条目——官方以后往模型菜单加任何新功能（含「启用智能体团队协作」开关）都会自动出现在这里，无需插件改版追赶。

**厂家排序**
- 首次使用无记录时**完全保持目录默认顺序**，不打乱既有习惯。
- 之后按**成功回复的消息数**降序，常用的自动浮到前面；同频次保持目录相对顺序（稳定排序），标签位置不会莫名跳动。

**品牌图标**
- 内置 simple-icons、models.dev 官方标与 HF 矢量化补位三级图标源，按模型→厂家→首字母依次回退。

**容错**
- 目录加载失败 / Provider 插件卸载 / 宿主服务缺席时自动降级：保留最后一次成功的目录，切换应急目录，或退让给原生选择器——不会白屏。

## 安装

**桌面客户端（DeepSeek Harness App）只能走应用内的 Plugins 页面。** 官方 CLI 会直接拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

用 CLI 装过 desktop profile 的话，插件可能只进了 `dependencies` 而没进 `dsh.profile.bundles`——装上了但没挂载，看起来就是"插件没生效"。请在 App 的 Plugins 页面安装并**打开开关**（开关才会把它写进有序 bundles 列表）。

下面的 CLI 用法适用于 `web` 等非桌面 profile：

```powershell
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-model-picker-plus

# 直接从 GitHub 安装（无需下载）
dsh plugin --profile web add github:objectyan/dsh-model-picker-plus

# 指定版本 tag
dsh plugin --profile web add "github:objectyan/dsh-model-picker-plus#v0.7.2"

# 或直接用 Release 的 tgz 链接
dsh plugin --profile web add "https://github.com/objectyan/dsh-model-picker-plus/releases/download/v0.7.2/dsh-model-picker-plus-0.7.2.tgz"
```

## 发布

打 tag 即发布，走 npm 可信发布（Trusted Publishing），无需长期 token：

```sh
git tag v0.7.2 && git push origin main --tags
```

Workflow 会依次校验 **tag 与 package.json 版本一致** → **跑测试** → **发布**，任一环节失败都不会推到 npm。
版本号里含 `-` 的 tag（如 `v0.6.0-alpha.1`）自动发到 `alpha` 通道，其余发 `latest`。

变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 宿主升级后自检

本插件靠优先级抢占 composer 的 `conversation.input.model` 槽位，属于对宿主结构敏感的插件：dsh 更新频繁，官方明确 `THERE WILL BE COMPATIBILITY-BREAKING CHANGES.`。仓库里的 `seams.json` 列出了它依赖的每一个宿主 seam，升级客户端后跑一次即可知道有没有断线（不需要跑起来才发现）：

```sh
node ../tools/dsh-api-snapshot.mjs capture                       # 按当前运行时版本存一份 API 契约快照
node ../tools/dsh-seam-check.mjs seams.json                       # 10 项逐条确认，缺任何一项退出码非 0
```

服务方法对照的是运行时自带的机器可读契约表（`dsh-tool-cordis/lib/types/api-catalog.js`，官方 CI 保证不过期），槽位 id 与包内符号则直接在 app.asar 里做字面量确认。运行时的 `DSH_ASAR` 环境变量可覆盖 asar 路径。

另外：即使宿主结构变了，本插件也不会把 composer 带崩——`slots.inject` / `slots.register` / `modelDirectories` / `sessions` 任一缺席都会在挂载前退让，原生选择器照常出现。
