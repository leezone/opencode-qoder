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

插件注册 `qoder` 提供商，内置 17 个模型——见[模型](#模型)。

## 模型

内置表使用以下 id。前五个是 Qoder 自己的档位别名，并非上游品牌；其余对应其上游模型名称：

| id | 上游模型 |
| --- | --- |
| `auto` | Auto（网关自动选择） |
| `ultimate` | Ultimate |
| `performance` | Performance |
| `efficient` | Efficient |
| `lite` | Lite |
| `qmodel_38max` | Qwen3.8-Max |
| `qfmodel` | Qwen3.8-Flash |
| `qmodel_latest` | Qwen3.7-Max |
| `qmodel` | Qwen3.7-Plus |
| `kmodel_latest` | Kimi-K3 |
| `kmodel` | Kimi-K2.7-Code |
| `gmodel` | GLM-5.3 |
| `gfmodel` | GLM-5.3-Flash |
| `dmodel` | DeepSeek-V4-Pro |
| `dfmodel` | DeepSeek-V4-Flash |
| `mmodel` | MiniMax-M3 |
| `cmodel` | Cantus |

credit 倍率、上下文档位与思考档位来自线上发现（下一节），随 Qoder 定价浮动；内置表不携带这些信息。此前列出的 `qmodel_preview` 与 `gm51model` 已在上游下线，不再内置。

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

## 工具与技能

插件加载后注册一组只读工具，可在对话中直接查询账户信息：

| 工具 | 回答什么 |
| --- | --- |
| `qoder_quota` | 剩余额度：plan / add-on / org package 各桶、合计、是否耗尽、续期日期 |
| `qoder_account` | 当前凭证所属的账户信息（姓名、邮箱、组织） |
| `qoder_models` | 全部可用模型：倍率、上下文限制、思考档位、`Unavailable` 标记 |
| `qoder_model` | 按 `id` 查单个模型详情；未知 id 会明确说明已回退到兜底模型 |
| `qoder_catalog` | 模型表来源（线上 / 缓存 / 内置兜底）、刷新时间、缓存路径 |
| `qoder_auth` | 当前生效的凭证层与解析结果——只报形态，绝不回显 token 值 |
| `qoder_tier_list` | 查看每个模型的可选上下文档位、本会话当前档位以及活跃的路由策略 |
| `qoder_tier_switch` | 为当前会话切换上下文档位（参数 `model`, `tier`；省略 `tier` 恢复默认） |
| `qoder_routing_policy` | 查看/设置子代理超档自动升级策略（无参数=查看） |

查询配额本身不计费：连续十次读取，用量计数器纹丝不动（2026-09-08 实测）。两次读取之间数字若发生变化，那是模型消耗，与这些工具无关。

仓库同时附带 `qoder-quota` 技能（`skills/qoder-quota/`），内含独立脚本，用于没有 opencode 会话在跑的场景（cron、裸 shell）：

```bash
node skills/qoder-quota/scripts/qoder-quota.mjs            # 人类可读
node skills/qoder-quota/scripts/qoder-quota.mjs --json     # 结构化输出
node skills/qoder-quota/scripts/qoder-quota.mjs --refresh  # 跳过缓存的 job token
```

脚本的凭证解析顺序与插件一致：`--pat`/`--token`，其次 `QODER_PERSONAL_ACCESS_TOKEN`/`QODER_PAT`，再次 `opencode.jsonc` 中的 `provider.qoder.options.apiKey`（自动展开 `{file:...}`），然后 `~/.qoderkey_pat`，最后 opencode 自身的 `auth.json`。

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

## 多账户

插件自己接管凭证文件：`~/.qoderkey_pat`（可用提供商选项 `keyFile` 或环境变量 `OPENCODE_QODER_KEY_FILE` 覆盖路径，设为 `none` 关闭该层）。不再需要在 `opencode.jsonc` 里写 `apiKey: "{file:...}"` 转发——插件在启动时以及每 60 秒自行读取该文件。同一套语法规则决定文件的角色：

- **孤立的单个令牌** → 就是你的凭证。它的签名行为与旧的 `{file:...}` 选项完全一致，优先级仅次于显式切换。
- **列表**（`,`/`;`/换行分隔，或 `OPENCODE_QODER_PAT=...` 赋值形式）→ 是**种子导入**：每个未见过的 `pt-` 段被加入 store（首个会激活空 store），此后由 store——而非文件——为请求鉴权。

变更检测基于 mtime：周期检查在稳态下只是一次 stat，代价可忽略；编辑文件后下一个 tick 即生效，无需重启。

store 位于 `~/.config/opencode/qoder-pats.json`（遵循 `XDG_CONFIG_HOME`），以 `0600` 权限写入。它只会被真实输入创建——列表形式的关键字文件、环境变量导入、或 `qoder_pat_add`——绝不会出现占位的假数据。可在对话中用 `qoder_pat_add`、`qoder_pat_list`、`qoder_pat_switch`、`qoder_pat_remove` 管理。

若要在完全不碰文件的情况下预置 store（全新机器、CI runner），把导入变量设为逗号或分号分隔的列表：

```bash
export OPENCODE_QODER_PAT="pt-aaa,pt-bbb"
opencode
```

这同样是一次性的**导入**，不是查找层：启动时每个未见过的 `pt-` 段会被加入（首个会激活空 store），此后是 store——而非该变量——为请求鉴权。`OPENCODE_QODER_PAT` 刻意与 `QODER_PERSONAL_ACCESS_TOKEN`/`QODER_PAT` 分开，因此永不与官方 Qoder CLI 冲突（那两个仍是单 PAT、保持原样）。导入完成后请 `unset` 该变量，免得令牌滞留在子进程环境里。

### 谁来为请求签名

从高到低：

| # | 层 | 来源 |
| --- | --- | --- |
| 1 | `personalAccessToken` 选项 | `opencode.jsonc` 提供商配置 |
| 2 | **显式选定** | `qoder_pat_switch <id>`——在被清除之前压过一切被动配置 |
| 3 | 连接凭证 / `apiKey` 选项 | `/connect` 或配置；列表形式的值会被跳过（那是导入种子，不是 bearer token） |
| 4 | 关键字文件中的孤立令牌 | `~/.qoderkey_pat` 里恰好只有一个令牌 |
| 5 | store 的 active 条目 | 首次导入时自动激活；由 `qoder_pat_switch` / `--use-pat` 翻转 |
| 6 | `QODER_PERSONAL_ACCESS_TOKEN` / `QODER_PAT` | 环境变量，与官方 CLI 保持一致、原样未动 |

这张表编码的就是兼容性规则：**单密钥优先级最高**（第 1–4 行压过 store，与旧的 `{file:...}` 配置行为一致）——但**主动行为压过被动配置**：`qoder_pat_switch` 之后，即使 `~/.qoderkey_pat` 里仍有令牌，也由选定的账户签名。不带 id 调用 `qoder_pat_switch` 即清除选定，把签名权交还给文件。

### 当对话完全打不通时如何恢复

上面的工具全都跑在对话*内部*——所以一旦 active 凭证被吊销或账户订阅过期，本该用来切换账户的东西本身就够不着了。免费的 `lite` 模型也不是出路：`x0` 免的是额度，不是鉴权。随附的 skill 脚本从一个普通 shell 打破这个死锁，读写的是插件用的同一个 store：

```bash
# 拿每个已存 PAT 打一次真实网关，列出可用的 id。
node ~/.config/opencode/skills/qoder-quota/scripts/qoder-quota.mjs --pats

# 按 id 或 label 激活一个健康的备用项（不健康者除非 --force 否则拒绝）。
node ~/.config/opencode/skills/qoder-quota/scripts/qoder-quota.mjs --use-pat=Work
```

运行中的 opencode 会在**下一个请求**时采纳这次翻转（store 按文件 mtime 重载——无需重启），所以 `--use-pat` 切到一个可用账户就是全部的恢复。`ACCOUNT-INACTIVE` 判定意味着整个账户都停了，因此*同*账户的备用项救不了你；用 `OPENCODE_QODER_PAT` 给另一个账户补一个 PAT。

### 一个死掉的凭证会让你失去什么

档位系统能把一个*超预算的对话*降级路由到免费 `lite`，但前提是得有某个凭证能通过鉴权。两种失效形态：

| 坏掉的东西 | 谁来恢复 |
| --- | --- |
| 交换令牌（job token）被吊销/过期 | 插件自动续期 |
| **PAT 本身**被吊销，或账户订阅过期 | 只能你来——`--use-pat` 切到健康备用项，或 `qoder_pat_add` / 重新 `/connect` 一个新 PAT |

切换到健康备用项就是全部的恢复——`--use-pat` 翻转 store，下一个请求采纳它，你继续在已经活过来的对话里干活。
