## 功能

把 DSH 原生的扁平模型选择器换成分组模型库。

**模型列表**
- **双行流式标签栏**：固定视图（推荐 / 最近使用 / 收藏 / 全部模型）之后紧接厂家标签，两行按实测宽度填满后才折叠，剩余厂家由「更多 N」承接——不会静默裁掉，也不会为「更多」单独占一行。
- **能力胶囊**：视觉 / 推理 / 工具 / 多模态 / 免费，按 endpoint 声明与快照综合判定，命中才显示。
- **思考档位可见**：可切换档位的模型在标题旁显示档位摘要（如 `High`、`思考 5 档`），点触发条上的档位文字就地切换，不必进大菜单翻「当前」卡片。
- **搜索与筛选**：跨厂家搜索模型名 / ID / 描述，按能力筛选。
- **收藏与最近使用**：置顶常用模型。

**厂家标签排序**
- 首次使用无记录时**完全保持目录默认顺序**，不打乱既有习惯。
- 之后按**成功回复的消息数**降序，常用的自动浮到前面。
- 同频次保持目录相对顺序（稳定排序），标签位置不会莫名跳动。

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
dsh plugin --profile web add "github:objectyan/dsh-model-picker-plus#v0.5.0"

# 或直接用 Release 的 tgz 链接
dsh plugin --profile web add "https://github.com/objectyan/dsh-model-picker-plus/releases/download/v0.5.0/dsh-model-picker-plus-0.5.0.tgz"
```

## 发布

打 tag 即发布，走 npm 可信发布（Trusted Publishing），无需长期 token：

```sh
git tag v0.5.0 && git push origin main --tags
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
