# opencode-qoder 系统架构文档

> 版本：0.2.1  
> 更新日期：2026-09-17  
> 代码总量：~6,800 行 TypeScript（src/）

## 1. 项目定位

opencode-qoder 是 [opencode](https://opencode.ai/) 的 **Qoder Global provider 插件**，将 Qoder 网关接入 opencode 的 AI SDK 接口。核心职责：

1. **认证**：PAT / 设备登录 / 密钥文件，多账号切换
2. **请求签名**：COSY 协议（RSA + AES + 自定义 base64 编码）
3. **模型发现**：动态拉取 Qoder 模型列表，三级缓存
4. **流式对话**：SSE 解析，tool call / 图片输入 / reasoning 支持
5. **上下文层级**：per-session context tier 管理
6. **子代理路由**：自动将 compaction/title 等子代理路由到免费模型
7. **能力工具**：12 个只读工具供模型查询账户/配额/模型信息

## 2. 模块总览

```
src/
├── index.ts              # 插件入口，opencode 生命周期钩子，工具注册
├── language-model.ts     # QoderLanguageModel — AI SDK v3 协议实现
├── auth.ts               # 凭证解析、设备登录、token 刷新
├── cosy.ts               # COSY 请求签名（RSA/AES/机器 ID）
├── encoding.ts           # Qoder 自定义 base64 编码（WAF 绕过）
├── transform.ts          # AI SDK prompt → Qoder 网关请求体转换
├── model-catalog.ts      # 动态模型发现，三级缓存
├── static-models.ts      # 静态模型回退表加载
├── models.json           # 内置模型定义（编译时复制）
├── quota.ts              # 配额查询（独立于模型列表）
├── capabilities.ts       # 只读能力报告层（工具的数据源）
├── pat-store.ts          # 多 PAT 存储（JSON 文件 + globalThis 缓存）
├── pat-import.ts         # PAT 批量导入（环境变量 / 密钥文件）
├── key-file.ts           # 种子密钥文件（~/.qoderkey_env）
├── tier-store.ts         # 上下文层级状态（per-session + display mode）
├── routing-policy.ts     # 子代理路由策略
├── session-roots.ts      # 会话父子关系追踪
├── shared-state.ts       # 跨 realm 状态通道（globalThis）
├── json-store.ts         # JSON 文件存储原语（XDG 路径）
├── http.ts               # HTTP 工具（超时 fetch、JSON headers）
├── constants.ts          # 常量、URL、类型定义
├── log.ts                # 可选诊断日志
├── env.ts                # 环境变量读取
└── coerce.ts             # 类型转换辅助函数
```

## 3. 模块依赖关系

```
                        ┌─────────────┐
                        │  index.ts   │  ← 插件入口，注册所有钩子和工具
                        └──────┬──────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌───────────────┐   ┌──────────────────┐   ┌─────────────────┐
│ language-     │   │ model-catalog.ts │   │ capabilities.ts │
│ model.ts      │   └────────┬─────────┘   └────────┬────────┘
└───────┬───────┘            │                      │
        │                    ▼                      │
        │           ┌──────────────────┐            │
        │           │ static-models.ts │            │
        │           └──────────────────┘            │
        │                                           │
        ├──────────────┬──────────────┬─────────────┤
        │              │              │             │
        ▼              ▼              ▼             ▼
┌───────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐
│ auth.ts   │  │ cosy.ts   │  │ quota.ts │  │ tier-    │
└─────┬─────┘  └─────┬─────┘  └────┬─────┘  │ store.ts │
      │              │             │         └────┬─────┘
      │              │             │              │
      ▼              ▼             ▼              ▼
┌───────────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐
│ pat-store │  │ encoding  │  │ http.ts  │  │ session- │
│ key-file  │  │ .ts       │  │          │  │ roots.ts │
│ pat-import│  └───────────┘  └──────────┘  └────┬─────┘
└─────┬─────┘                                    │
      │                                          │
      └──────────────────┬───────────────────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │ shared-      │  ← globalThis 跨 realm 通道
                  │ state.ts     │
                  └──────┬───────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        ┌──────────┐ ┌────────┐ ┌──────────┐
        │ json-    │ │ log.ts │ │ env.ts   │
        │ store.ts │ └────────┘ └──────────┘
        └──────────┘
              │
              ▼
        ┌──────────┐
        │coerce.ts │  ← 叶子节点，无依赖
        └──────────┘
```

## 4. 插件生命周期

opencode 在单个进程中加载此插件 **两次**（legacy 实例 + v2 实例），两个实例不共享模块状态。

```
opencode 启动
    │
    ├── setupLegacy() ─── 配置钩子
    │   ├── 注册 provider 名称、环境变量
    │   ├── 设置 apiKey / baseURL
    │   ├── 读取密钥文件 → 发布到 globalThis
    │   ├── 注册模型配置（legacy 格式）
    │   ├── 配置子代理默认模型（lite）
    │   └── 注册工具（qoder_quota 等）
    │
    └── setupV2() ──── 目录钩子
        ├── 导入 PAT（环境变量 / 密钥文件）
        ├── 注册 integration 方法（key / env）
        ├── 注册模型目录（v2 格式）
        ├── 注册 bundled skill
        ├── 注册 aisdk handler
        ├── 启动模型发现定时器（15 分钟）
        ├── 启动密钥文件检查定时器（60 秒）
        └── 发布 refreshCatalog 闭包到 globalThis
```

**跨 realm 通信**：通过 `shared-state.ts` 在 `globalThis` 上读写，传递：
- API Key（legacy → v2）
- PAT store 缓存
- tier store 缓存
- session 父子映射
- refreshCatalog 触发闭包

## 5. 认证流程

### 5.1 凭证解析优先级

```
1. 显式 PAT 选择（qoder_pat_switch）     ← pat-store.ts
2. 密钥文件（~/.qoderkey_env）           ← key-file.ts
3. 插件选项 apiKey                       ← opencode.json
4. opencode auth.json 存储               ← auth.ts
5. 环境变量 QODER_PERSONAL_ACCESS_TOKEN  ← auth.ts
6. 环境变量 QODER_PAT                    ← auth.ts
7. PAT store 自动激活条目                ← pat-store.ts
```

### 5.2 设备登录流程

```
用户 → /connect qoder
    │
    ▼
pollDeviceFlow() ──── POST /api/v1/deviceToken/poll
    │                      （轮询，直到用户授权）
    ▼
获取 refresh_token + user_id + machine_id
    │
    ▼
exchangeJobToken() ── POST /api/v1/jobToken/exchange
    │                      （换取短期 job token）
    ▼
存储到 opencode auth.json
    │
    ▼
resolveQoderCredentials() ── 每次请求前解析
    │
    ├── job token 未过期 → 直接使用
    └── job token 过期   → refreshQoderCredentials()
                              POST /algo/api/v3/user/refresh_token
```

### 5.3 PAT 流程

```
PAT (pt-...)
    │
    ▼
exchangeJobToken() ── POST /api/v1/jobToken/exchange
    │                      （Bearer: pt-...）
    ▼
获取 job token + expires_at
    │
    ▼
缓存到 credentialsCache（内存）
    │
    ▼
每次请求前检查过期 → 重新 exchange
```

## 6. 请求生命周期

```
opencode 发起对话请求
    │
    ▼
QoderLanguageModel.doStream()
    │
    ├── resolveQoderCredentials()
    │   └── 解析当前凭证（PAT / OAuth / env）
    │
    ├── resolveReasoningEffort()
    │   └── 从 variant / options 提取 thinking 强度
    │
    ├── resolveRouting()
    │   └── 检查是否为子代理 → 可能切换模型
    │
    ├── getSessionTier() / getSelectedTier()
    │   └── 确定 context_length 参数
    │
    ├── transformPrompt() + transformTools()
    │   └── AI SDK 格式 → Qoder 网关格式
    │
    ├── buildAuthHeaders()
    │   ├── COSY 签名（RSA + AES）
    │   └── qoderEncodeBody()（自定义 base64）
    │
    ├── POST /algo/api/v2/service/pro/sse/agent_chat_generation
    │   └── SSE 流式响应
    │
    └── 解析 SSE 事件
        ├── content_block_start → text_start / tool_call_start
        ├── content_block_delta → text_delta / tool_call_delta
        ├── content_block_stop  → text_end / tool_call_end
        ├── message_start       → 模型/用量信息
        └── message_delta       → finish_reason
```

### 6.1 错误处理

```
HTTP 错误 / SSE 内嵌错误
    │
    ├── code "112" → 配额耗尽
    │   └── setQuotaExhausted(true) → 模型名加 "Unavailable"
    │
    ├── code "105" → 登录过期
    │   └── 清除凭证缓存 → 重新 exchange
    │
    ├── 401/403 → 认证失败
    │   └── 同上
    │
    └── 其他 → APICallError 抛出
```

## 7. 模型发现

### 7.1 三级数据源

```
优先级 1: "qoder"   ── 实时 API 响应
    │                    POST /algo/api/v2/model/list
    │                    带 COSY 签名
    ▼
优先级 2: "cache"   ── 磁盘缓存
    │                    ~/.cache/opencode/opencode-qoder-models.json
    │                    启动时加载，成功刷新后覆写
    ▼
优先级 3: "fallback" ── 内置静态表
                         src/models.json
                         可通过 QODER_STATIC_MODELS 覆盖
```

### 7.2 刷新机制

```
启动时：setTimeout(0) → 立即刷新（不阻塞启动）
定时器：setInterval(15 分钟) → TTL 节流
         实际 TTL = QODER_MODEL_CACHE_SECONDS（默认 1 小时）
变更检测：catalogSignature() 比较 → ctx.catalog.reload()
```

### 7.3 模型定义字段

```typescript
QoderModelDefinition {
  id: string              // 模型标识（如 "qmodel_38max"）
  name: string            // 显示名称
  reasoning: boolean      // 是否支持推理
  supportsEffort: boolean // 是否支持 thinking 强度
  efforts?: string[]      // 可用强度（如 ["high", "low", "max"]）
  contextTiers?: number[] // 可用上下文窗口
  input: ("text"|"image")[] // 支持的输入类型
  contextWindow: number   // 默认上下文窗口
  inputWindow?: number    // 输入预算（≤ contextWindow）
  maxTokens: number       // 最大输出 token
  priceFactor?: number    // 信用乘数（如 0.5, 1.0, 2.0）
}
```

## 8. 状态管理

### 8.1 持久化状态（JSON 文件）

| 文件 | 位置 | 用途 |
|------|------|------|
| `qoder-pats.json` | `~/.config/opencode/` | 多 PAT 存储 |
| `qoder-tiers.json` | `~/.config/opencode/` | 上下文层级选择 |
| `qoder-routing.json` | `~/.config/opencode/` | 子代理路由策略 |
| `opencode-qoder-models.json` | `~/.cache/opencode/` | 模型列表磁盘缓存 |

所有路径遵循 XDG 规范（`XDG_CONFIG_HOME` / `XDG_CACHE_HOME`）。

### 8.2 内存状态（globalThis）

| Key | 类型 | 用途 |
|-----|------|------|
| `__opencode_qoder_api_key` | string | 跨 realm API Key 传递 |
| `__opencode_qoder_pat_store` | PATStoreData | PAT store 缓存 |
| `__opencode_qoder_tier_store` | TierStoreData | tier store 缓存 |
| `__opencode_qoder_routing_policy` | RoutingPolicy | 路由策略缓存 |
| `__opencode_qoder_session_parents` | Record<string, string> | 会话父子映射 |
| `__opencode_qoder_refresh_trigger` | () => void | 强制刷新闭包 |
| `__opencode_qoder_key_file_*` | various | 密钥文件状态 |

### 8.3 模块级状态

| 模块 | 状态 | 用途 |
|------|------|------|
| `auth.ts` | `credentialsCache` | job token 缓存（Map） |
| `model-catalog.ts` | `liveModels`, `fetchedAt`, `expiresAt` | 内存模型列表 |
| `quota.ts` | `quotaExhausted` | 配额耗尽标记 |
| `tier-store.ts` | `mode`, `sessions` | 层级选择（内存副本） |

## 9. 工具注册

插件注册 12 个只读工具，供模型查询账户信息：

| 工具 | 数据源 | 用途 |
|------|--------|------|
| `qoder_quota` | `quota.ts` | 查询剩余额度 |
| `qoder_account` | `auth.ts` | 查询账户信息 |
| `qoder_models` | `model-catalog.ts` | 列出所有模型 |
| `qoder_model` | `model-catalog.ts` | 查询单个模型详情 |
| `qoder_catalog` | `model-catalog.ts` | 模型目录诊断 |
| `qoder_auth` | `auth.ts` | 认证状态 |
| `qoder_pat_list` | `pat-store.ts` | 列出存储的 PAT |
| `qoder_pat_switch` | `pat-store.ts` | 切换活跃 PAT |
| `qoder_pat_add` | `pat-store.ts` | 添加新 PAT |
| `qoder_pat_remove` | `pat-store.ts` | 删除 PAT |
| `qoder_tier_list` | `tier-store.ts` | 列出可用上下文层级 |
| `qoder_tier_switch` | `tier-store.ts` | 切换上下文层级 |

## 10. 子代理路由策略

```
默认策略：
┌─────────────────────────────────────────────────────────┐
│ 主代理（build）：用户选择的模型                          │
│                                                         │
│ 子代理（plan/general/explore/title/compaction）：        │
│   ├── 上下文 ≤ 200K → lite（免费）                      │
│   └── 上下文 > 200K → qfmodel（最便宜的付费模型）        │
│                                                         │
│ 豁免：title 始终用 lite（短提示，免费，频繁触发）         │
└─────────────────────────────────────────────────────────┘

配置文件：~/.config/opencode/qoder-routing.json
{
  "enabled": true,
  "subagentModel": "lite",
  "target": "qfmodel",
  "threshold": 200000,
  "exemptAgents": ["title"]
}
```

## 11. COSY 签名协议

Qoder 网关要求请求体经过特殊签名，防止 WAF 拦截：

```
1. 构建 COSY payload：
   {
     version: "v2",
     requestId: UUID,
     info: AES-128-CBC(用户信息),
     cosyVersion: "1.1.42",
     ideVersion: "1.0.0"
   }

2. 用户信息加密：
   info = {
     uid: userID,
     security_oauth_token: authToken,
     name: name,
     aid: machineID,
     email: email
   }
   encrypted = AES-128-CBC(info, key=uid前16字节)
   其中 key = RSA(publicKey, machineID) 的前 16 字节

3. 请求体编码：
   body = JSON.stringify({ payload, encodeVersion: "1", ... })
   encoded = qoderEncodeBody(body)
   // 自定义 base64：字符重排 + 字母表替换

4. 请求头：
   Authorization: Bearer <job_token>
   Cosy-Version: 1.1.42
   Cosy-Clienttype: 5
   X-Request-Id: UUID
   AI-CLIENT-TIMESTAMP: <unix_seconds>
```

## 12. 关键设计决策

### 12.1 为什么用 globalThis 而不是模块状态？

opencode 在单进程中加载插件两次（legacy + v2），两个实例的模块状态互不可见。`globalThis` 是唯一的跨 realm 通道。

### 12.2 为什么模型发现要三级缓存？

- **实时**：最新数据，但需要网络 + 凭证
- **磁盘**：启动时立即可用，离线时兜底
- **静态**：代码内置，极端情况下的最后防线

### 12.3 为什么子代理默认用 lite？

lite 是免费模型（200K 上下文），用于 title/compaction/plan 等机械任务，节省配额。只有当对话超过 200K 时才升级到付费模型。

### 12.4 为什么密钥文件是"活的"？

每 60 秒检查 mtime，文件修改后自动重新导入，无需重启。这使得 CI/CD 环境可以动态更新凭证。

## 13. 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `QODER_PERSONAL_ACCESS_TOKEN` | PAT 认证 | - |
| `QODER_PAT` | PAT 认证（备选） | - |
| `OPENCODE_QODER_PAT` | 批量导入 PAT | - |
| `OPENCODE_QODER_KEY_FILE` | 密钥文件路径 | `~/.qoderkey_env` |
| `QODER_DISABLE_MODEL_DISCOVERY` | 禁用模型发现 | - |
| `QODER_MODEL_LIST_URL` | 覆盖模型列表端点 | - |
| `QODER_MODEL_CACHE_SECONDS` | 模型缓存 TTL | 3600 |
| `QODER_MODEL_DISK_CACHE` | 覆盖磁盘缓存路径 | - |
| `QODER_STATIC_MODELS` | 自定义静态模型表 | - |
| `OPENCODE_QODER_LOG_FILE` | 诊断日志路径 | - |
| `QODER_DISABLE_BUNDLED_SKILL` | 禁用内置 skill | - |

## 14. 测试覆盖

```
src/__tests__/
├── auth-failure-note.test.ts    # 认证失败处理
├── capabilities.test.ts         # 能力报告
├── credential-precedence.test.ts # 凭证优先级
├── discovery.test.ts            # 模型发现
├── encoding.test.ts             # COSY 编码
├── env-isolation.setup.ts       # 环境隔离
├── key-file.test.ts             # 密钥文件
├── login-expiry.test.ts         # 登录过期
├── log.test.ts                  # 日志
├── pat-import.test.ts           # PAT 导入
├── pat-store.test.ts            # PAT 存储
├── quota.test.ts                # 配额
├── routing-policy.test.ts       # 路由策略
├── session-roots.test.ts        # 会话根
├── static-models.test.ts        # 静态模型
├── stream.test.ts               # SSE 流解析
├── tier-store.test.ts           # 层级存储
├── transform.test.ts            # 请求转换
└── xdg-paths.test.ts            # XDG 路径
```

运行测试：`pnpm test`

## 15. 构建与发布

```bash
pnpm install        # 安装依赖
pnpm build          # 编译 TypeScript → dist/
pnpm check          # 类型检查
pnpm lint           # Biome 检查
pnpm test           # 运行测试
```

发布产物：
- `dist/` — 编译后的 JS + 类型定义
- `skills/` — 内置 skill（qoder-quota）
- `README.md` / `README.zh-CN.md` — 文档
- `LICENSE` — MIT

## 16. 已知限制

1. **仅支持 Global 站**：中国站端点和模型别名未实现
2. **无 TTS**：Qoder 网关不提供语音合成端点
3. **ASR 仅调研**：WebSocket ASR 端点已识别但未实现
4. **单进程双实例**：需要 globalThis 通道，增加复杂度
5. **COSY 签名硬编码**：RSA 公钥和算法版本固定

## 17. 扩展点

未来可添加的接口（参见 `docs/qoder-api-roadmap.md`）：

- `/api/v3/service/region/endpoints` — 动态区域发现
- `/algo/api/v2/service/voice/polish` — ASR 后处理
- `/api/v3/user/status` + `/api/v2/user/plan` — 账户状态
- `/api/v2/image/upload` — 图片上传
- `/api/v1/webSearch/*` — 网页搜索
- `/algo/api/v2/service/pro/imageSearch` — 图片搜索
- `/algo/api/v2/service/pro/generateImage` — 图片生成
