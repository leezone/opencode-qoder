# opencode-qoder

[English](README.md) | 简体中文

适用于 [opencode](https://opencode.ai/) 的 Qoder Global 提供商插件。移植自 `pi-provider-qoder` 中仅限国际站的部分：PAT 兑换、COSY 请求签名、Qoder 请求体编码、聊天 SSE 解析、推理输出、图片输入与工具调用。

有意不包含 Qoder 中国站的端点与模型别名。

## 构建

```bash
pnpm install
pnpm build
```

## 安装

将插件添加到 `opencode.json`，或按你的配置位置调整路径：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qoder"],
  "model": "qoder/auto"
}
```

插件注册 `qoder` 提供商，内置以下模型：`auto`、`ultimate`、`performance`、`efficient`、`lite`、`qmodel_38max`、`qfmodel`、`qmodel_latest`、`qmodel`、`kmodel_latest`、`kmodel`、`gmodel`、`gfmodel`、`dmodel`、`dfmodel`、`mmodel`、`qmodel_preview`、`gm51model`。

## 模型发现

启动时拉取线上模型列表，之后每 15 分钟刷新一次；列表变化时自动重载 opencode 的目录。最近的线上列表缓存在 `~/.cache/opencode/opencode-qoder-models.json`，重启后仍可用。内置表作为兜底。

声明了推理力度档位的模型会为每档生成一个变体（如 `kmodel_latest` 的 `high`、`low`、`max`），可在 opencode 的模型选择器中切换。

模型名称会带上 Qoder 的 credit 倍率，如 `(0.5x)`；限时促销期间显示 `(Free)`。credits 用尽后，付费模型标记为 `Unavailable` 但仍可选，免费和 0 倍率模型不标记。两者均来自线上列表，回落到内置表时不显示。

| 环境变量 | 作用 |
| --- | --- |
| `QODER_DISABLE_MODEL_DISCOVERY` | 设为 `1`、`true` 或 `yes` 关闭发现 |
| `QODER_MODEL_LIST_URL` | 覆盖模型列表端点 |
| `QODER_MODEL_CACHE_SECONDS` | 目录缓存时长（秒，默认 3600） |
| `QODER_MODEL_DISK_CACHE` | 覆盖磁盘缓存路径 |

## 认证

使用 Qoder 个人访问令牌（PAT，`pt-...`）。请求前会自动兑换为短时效 job token。

```bash
export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
opencode
```

`QODER_PAT` 为等效别名。

也可以走 opencode 的认证流程：

```text
/connect qoder
```

选择 `Personal Access Token` 并粘贴 PAT。

修改插件配置后需退出并重启 opencode，插件与提供商配置仅在启动时加载。
