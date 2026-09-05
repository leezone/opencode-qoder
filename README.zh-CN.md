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

启动时拉取线上模型列表，之后每 15 分钟刷新一次；列表变化时自动重载 opencode 的目录。最近的线上列表缓存在 `~/.cache/opencode/opencode-qoder-models.json`，重启后仍可用。线上与缓存都不可用时，使用静态兜底表。

静态兜底表是随插件代码一起发布的预制 JSON 文件 `models.json`，仅保留当前上线的模型。需要为特殊情况手改时，把你的副本放到 `~/.config/opencode/qoder-models.json`（遵循 `XDG_CONFIG_HOME`），或用 `QODER_STATIC_MODELS` 指向任意路径。优先级为：环境变量 → 用户文件 → 预制文件。每个文件是 JSON 数组（或 `{"models": [...]}`），条目需含 `id`、`name`、`reasoning`、`supportsEffort`、`input`、`contextWindow`、`maxTokens`（可选 `inputWindow`，须 ≤ `contextWindow`）；无效条目逐条丢弃，一处笔误不会清空整表。线上列表具有权威性：它已不再展示的模型，即使离线也会被隐藏，因此手动添加的 id 只在兜底路径生效，不会覆盖线上结果。

声明了推理力度档位的模型会为每档生成一个变体（如 `kmodel_latest` 的 `high`、`low`、`max`），可在 opencode 的模型选择器中切换。

模型名称会带上 Qoder 的 credit 倍率，如 `(0.5x)`。credits 用尽后，付费模型追加 `Unavailable` 后缀（如 `(0.5x, Unavailable)`）但仍可选，0 倍率模型不受影响。两者均来自线上列表，回落到静态表时不显示。

| 环境变量 | 作用 |
| --- | --- |
| `QODER_DISABLE_MODEL_DISCOVERY` | 设为 `1`、`true` 或 `yes` 关闭发现 |
| `QODER_MODEL_LIST_URL` | 覆盖模型列表端点 |
| `QODER_MODEL_CACHE_SECONDS` | 目录缓存时长（秒，默认 3600） |
| `QODER_MODEL_DISK_CACHE` | 覆盖磁盘缓存路径 |
| `QODER_STATIC_MODELS` | 指向自定义静态兜底表（JSON）的路径 |
| `OPENCODE_QODER_LOG_FILE` | 将诊断信息（credit 配额、目录刷新）追加到该路径。默认未设置，即不记录任何日志 |

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
