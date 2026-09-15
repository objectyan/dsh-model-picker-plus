# dsh-model-picker-plus

把 DSH 聊天输入框里的模型选择器替换为更适合多 Provider 场景的模型库。
A grouped, searchable replacement for the DeepSeek Harness composer model selector.

## 功能

- Provider 分组，默认折叠，只展开当前模型所在组
- 搜索 Provider / 模型名 / 模型 ID / 描述
- 收藏模型、最近使用
- 保留 DSH 原生思考强度（reasoning effort）选择
- 显示 Free / Vision / Omni / Reasoning / Tools 能力标签
- 能力过滤：全部 / 免费 / 视觉 / 推理 / 工具
- 如果安装了 `dsh-model-health`，会读取它的 localStorage 健康结果；同时也会读取 `dsh-model-hub` 的手动健康检查结果，显示最近可用状态和延迟
- 复用 DSH 自己的 `modelDirectories` 和 `sessions.selectModel`，不改任何 Provider 插件
- 容器足迹与原生选择器一致（block 容器、`min-width: 0`），不会挤压聊天输入区右侧的其他插件

## 安装

```powershell
# 从 GitHub 指定 tag 安装
dsh plugin --profile desktop add "github:<owner>/dsh-model-picker-plus#v0.2.5"

# 或先下载 Release 里的 tgz 再安装
dsh plugin --profile desktop add .\dsh-model-picker-plus-0.2.5.tgz
```

## 回滚

禁用或卸载本插件后，DSH 原生模型选择器会恢复。

```powershell
dsh plugin --profile desktop remove dsh-model-picker-plus
```

## 开发

```powershell
node --check client.js
node tests/client.mjs
```

纯客户端插件：`client.js` 通过 `__ModuleLoader__.load` 注册，`cordis.patch.yml` 声明 slot 注入点，无构建步骤。

## License

MIT
