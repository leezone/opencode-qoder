# Qoder API 接口调研与整合路线图

> 调研日期：2026-09-16  
> 调研目标：识别 opencode-qoder 尚未实现的 Qoder 接口，评估整合价值

## 已实现的接口

当前仓库已实现以下核心接口：

| 接口 | 路径 | 文件位置 |
|---|---|---|
| 模型列表 | `algo/api/v2/model/list` | `src/constants.ts:14` |
| 配额查询 | `openapi/api/v2/quota/usage` | `src/constants.ts:15` |
| 对话流 | `algo/api/v2/service/pro/sse/agent_chat_generation` | `src/constants.ts:16` |
| jobToken 兑换 | `openapi/api/v1/jobToken/exchange` | `src/constants.ts:17` |
| 用户信息 | `openapi/api/v1/userinfo` | `src/constants.ts:18` |
| Token 刷新 | `center/algo/api/v3/user/refresh_token` | `src/constants.ts:19` |
| 设备登录 | `deviceToken/poll` + `refresh_token` | `src/auth.ts` |

## 待实现的接口

### 高优先级（低风险、直接增强现有能力）

#### 1. 区域端点动态发现
- **端点**: `/api/v3/service/region/endpoints`
- **说明**: 动态获取各区域 base URL，替换硬编码域名
- **价值**: 天然支持中国站，无需手动维护域名映射
- **来源**: qodercli-1.0.34 二进制提取

#### 2. 语音润色（ASR 后处理）
- **端点**: `/algo/api/v2/service/voice/polish`
- **方法**: POST
- **说明**: ASR 识别结果润色（标点、大小写、流畅度）
- **请求体**: `{ session_id, request_id, client_type, messages: [{role:"user", content:"<transcription>原始文本</transcription>"}] }`
- **响应**: `{ result: { content: "润色后文本" } }` 或 `{ messages: "润色后文本" }`
- **超时**: 5000ms
- **价值**: 配合已有 ASR 调研，Paseo 可直接使用
- **来源**: qodercli-1.0.34 二进制提取

#### 3. 用户状态与套餐计划
- **端点**: 
  - `/api/v3/user/status` (openapi 域)
  - `/api/v2/user/plan` (openapi 域)
- **说明**: 比 userinfo 更细的账号状态（含机器/风控状态）和订阅计划详情
- **价值**: 增强 `qoder_quota` 技能，显示套餐/风控状态
- **来源**: dsh-provider-qoder 实现

#### 4. 图片上传 ✅ 已实现（`src/image-upload.ts`）
- **端点**: `PUT /algo/api/v2/image/upload`（center 域，带 `request_id` 查询参数）
- **签名**: 签的是 **body 长度字符串**（`String(body.length)`），不是 multipart 原始字节；
  签名路径去掉 `/algo` 前缀（`computeSigPath` 已处理）
- **降级**: 任何失败都回落到 inline data URL，绝不因此让对话失败
- **缓存**: 按内容摘要寻址，单飞合并并发上传；URL 30 分钟 TTL
  （上游返回的是预签名 OSS URL，实测有效期 30 天，缓存 TTL 取保守值）
- **来源**: qodercli 图片发布流程 + dsh-provider-qoder 实现

### 中优先级（可作为 opencode 工具暴露）

#### 5. 网页搜索
- **端点**: 
  - `/api/v1/webSearch/oneSearch` (国际站)
  - `/api/v1/webSearch/unifiedSearch` (灵码/阿里环境)
- **方法**: POST
- **请求体**: `{ query, timeRange: "NoLimit", contents: { mainText: false, markdownText: false, summary: false } }`
- **响应**: `{ pageItems: [...], requestId }`
- **价值**: 可作为 opencode 工具暴露
- **注意**: 有额度成本，需 gate
- **来源**: qodercli-1.0.34 二进制提取

#### 6. 图片搜索
- **端点**: `/algo/api/v2/service/pro/imageSearch?Encode=1`
- **方法**: POST
- **请求体**: `{ query, count: 1-10 }`
- **价值**: 可作为 opencode 工具暴露
- **来源**: qodercli-1.0.34 二进制提取

#### 7. 图片生成
- **端点**: `/algo/api/v2/service/pro/generateImage?Encode=1`
- **方法**: POST
- **请求体**: `{ model: "ge3i", prompt, size: "1024x1024" }`
- **支持尺寸**: 1024x1024, 1536x1024, 1024x1536, 768x1024, 1024x768, 1024x1280, 1280x1024, 1024x1792, 1792x1024, 2560x1080
- **响应**: `{ data: [{ url: "..." }], created: ... }`
- **价值**: 可作为 opencode 工具暴露
- **注意**: 有额度成本，需 gate
- **来源**: qodercli-1.0.34 二进制提取

#### 8. BYOK 配置（自带 API Key）
- **端点**: 
  - `/algo/api/v2/byok/config`
  - `/algo/api/v2/byok/check`
- **说明**: 用户自带 API Key 接入 Qoder 通道
- **价值**: 高级用户自定义模型接入
- **来源**: qodercli-1.0.34 二进制提取

### 低优先级（IDE/CLI 专属，opencode 场景价值低）

以下接口主要服务于 IDE/CLI 交互链路，对 opencode provider 场景基本无用：

- `/api/v1/remote/sessions` — 远程会话
- `/api/v1/remote/environments` — 远程环境
- `/api/v1/remote/code/sessions` — 远程代码会话
- `/api/v1/organizations/` — 组织管理
- `/api/v1/inner/organizations/` — 内部组织
- `/api/v1/me/integrations/github/repo-access` — GitHub 仓库访问
- `/api/v2/service/integrations/github/app/*` — GitHub App 集成
- `/api/v1/qcs/config/resolve` — QCS 配置解析
- `/api/v1/qcs/config/stream` — QCS 配置流
- `/api/v2/config/getDataPolicy` — 获取数据策略
- `/api/v2/config/updateDataPolicy` — 更新数据策略
- `/api/v2/service/ask/queue/status` — 任务队列状态
- `/api/v1/tracking` — 埋点追踪
- `/api/v2/spans` — 追踪跨度
- `/algo/api/v1/ping` — 心跳
- `/api/v1/jobToken/refresh` — jobToken 独立刷新

### Cloud Agent（托管 Agent）

- **端点**: `https://api.qoder.com/api/v1/cloud`
- **子端点**:
  - `/agents` — Agent 列表
  - `/sessions` — 会话列表
  - `/sessions/{id}/events` — 会话事件
  - `/sessions/{id}/events/stream` — 会话事件流（SSE）
- **说明**: 官方托管 Agent 服务
- **价值**: 整合成本高、收益窄，不建议优先
- **来源**: @qoder-ai/qoder-agent-sdk

## 中国站域名

来自 dsh-provider-qoder 实现：

| 域名类型 | 中国站 URL | 国际站 URL |
|---|---|---|
| baseUrl | `https://gateway.qoder.com.cn/` | `https://api3.qoder.sh/` |
| openapi | `https://openapi.qoder.com.cn` | `https://openapi.qoder.sh` |
| center | `https://gateway.qoder.com.cn` | `https://center.qoder.sh` |

**注意**: 中国站的 center 与 baseUrl 同域（gateway.qoder.com.cn），国际站不同（center.qoder.sh vs api3.qoder.sh）。

## 确认不存在的接口

- **TTS (文本转语音)**: 二进制中无语音合成端点，`synthesize*` 全是 JSON 库术语

## 社区项目参考

### dsh-provider-qoder@0.2.1
- **信息量最大**，实现了 image/upload + user/plan + user/status
- 提供中国站域名映射
- 仓库: `https://github.com/mo-n/dsh-provider-qoder`

### @hangox/qoder-proxy@0.1.4
- Anthropic Messages API → Qoder 中国站代理
- 使用 `/api/v1/deviceToken/refresh` (CN 站登录刷新)
- 仓库: `https://github.com/hangox/qoder-proxy`

### @qoder-ai/qoder-agent-sdk@1.0.41
- **官方 SDK**，走 stdio/JSON-RPC 驱动 qodercli
- 暴露 Cloud Agent 端点
- 包含 BYOK / memory / skill-evolution / plugins / hooks
- 未发布源码

### opencode-qoder-bridge@0.1.10
- 同类 opencode 插件，走官方 SDK 而非逆向 HTTP
- 仓库: `https://github.com/naoufalelbani/opencode-qoder-bridge`

## 实现建议

### 第一阶段（建议先做）
1. **区域端点发现** `/api/v3/service/region/endpoints`
   - 替换硬编码域名
   - 改动小、可测试
   - 天然支持中国站

2. **用户状态与套餐** `/api/v3/user/status` + `/api/v2/user/plan`
   - 增强 `qoder_quota` 技能
   - 显示套餐/风控状态
   - 直接复用现有认证流程

3. **语音润色** `/algo/api/v2/service/voice/polish`
   - 配合已有 ASR 调研
   - 实现简单（POST JSON）
   - Paseo 可直接使用

### 第二阶段
4. **图片上传** `/api/v2/image/upload`
   - 需要实现 multipart 构建
   - 需要 COSY 签名
   - 参考 dsh-provider-qoder 实现

### 第三阶段（可选）
5. **网页/图片搜索/生成** — 作为 opencode 工具暴露
   - 需要设计工具接口
   - 需要额度 gate
   - 参考 qodercli 内置工具实现

## 调研方法

- **官方 qodercli 二进制**: `strings` 提取端点路径
- **npm 社区包**: 通过 npmmirror 下载分析（GitHub 直连被墙）
- **本地 QoderCN 安装**: 检查 `~/.qoder/bin/qodercli/qodercli-1.0.34`

## 备注

- 所有端点路径均经过 qodercli-1.0.34 二进制验证
- 中国站域名来自 dsh-provider-qoder 实际实现
- 社区包分析基于 npm 最新发布版本
- TTS 不存在已多次确认（二进制中无相关端点）
