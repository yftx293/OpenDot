# Miniclaw Web API

本文档记录当前公开路由族和主要端点。请求/响应 Schema 以对应的
`src/routes/*.ts`、`src/schemas.ts` 和前端 API 调用为准。

## 约定

- API 默认前缀为 `/api`，WebSocket 为 `/ws`。
- 普通用户接口需要有效的 Miniclaw Cookie Session。明确标记 Public、专用设备传输和下述私有云端回调使用各自的认证机制。
- 资源接口还会执行 owner、角色、Permission、Host 执行权限等检查，见
  [ACL 权限矩阵](ACL-MATRIX.md)。
- 其他用户的资源通常以 `404` 返回，避免泄漏资源是否存在。
- Secret 写入后加密保存；读取 API 只返回脱敏值或“是否已配置”状态。

## 路由模块

| 前缀                               | 实现                               | 用途                          |
| ---------------------------------- | ---------------------------------- | ----------------------------- |
| `/api/auth`                        | `src/routes/auth.ts`               | 初始化、登录、账户、设备      |
| `/api/groups`                      | `src/routes/groups.ts`             | 工作区兼容模型、消息和环境    |
| `/api/groups`                      | `src/routes/files.ts`              | 工作区文件                    |
| `/api/groups`                      | `src/routes/agents.ts`             | Runtime Session 与渠道绑定    |
| `/api/groups`                      | `src/routes/workspace-config.ts`   | 项目 Skills/MCP               |
| `/api/workspaces`                  | `src/routes/workspaces.ts`         | Agent-first 工作区投影        |
| `/api/bot-groups`                  | `src/routes/bot-groups.ts`         | 群成员、时间线与回执          |
| `/api/agent-profiles`              | `src/routes/agent-profiles.ts`     | 产品级 Agent                  |
| `/api/channel-accounts`            | `src/routes/channel-accounts.ts`   | 多渠道账号                    |
| `/api/config`                      | `src/routes/config.ts`             | Provider、系统与兼容渠道配置  |
| `/api/tasks`                       | `src/routes/tasks.ts`              | 定时任务和运行                |
| `/api/goals`                       | `src/routes/goals.ts`              | Personal Goal 与关联任务控制  |
| `/api/team-overview`               | `src/routes/team-overview.ts`      | 本人的团队、目标与待处理快照  |
| `/api/github-goals`                | `src/routes/github-triggers.ts`    | 签名 GitHub 事件与例行任务    |
| `/api/cloud-runtime`               | `src/routes/cloud-runtime.ts`      | 私有云端权限与模型代理回调    |
| `/api/device-nodes`                | `src/routes/device-nodes.ts`       | 配对、有限文件授权与节点传输  |
| `/api/local-device-setup`          | `src/routes/local-device-setup.ts` | 本机设备安装与就绪检查        |
| `/api/observability`               | `src/routes/observability.ts`      | 管理员可观测性配置            |
| `/api/personal-memory`             | `src/routes/personal-memory.ts`    | 显式授权的个人记忆与修订范围  |
| `/api/mem0-private`                | `src/routes/mem0-private.ts`       | 私聊 Mem0 配置                |
| `/api/memory`                      | `src/routes/memory.ts`             | Workspace Memory v2           |
| `/api/skills`                      | `src/routes/skills.ts`             | 用户 Skills                   |
| `/api/mcp-servers`                 | `src/routes/mcp-servers.ts`        | 用户/系统 MCP                 |
| `/api/plugins`                     | `src/routes/plugins.ts`            | Plugin Catalog 与用户启用状态 |
| `/api/usage`                       | `src/routes/usage.ts`              | Token 用量                    |
| `/api/billing`                     | `src/routes/billing.ts`            | 订阅、余额和计费管理          |
| `/api/admin`                       | `src/routes/admin.ts`              | 用户、邀请和审计              |
| `/api/bug-report`                  | `src/routes/bug-report.ts`         | 脱敏问题报告                  |
| `/api/browse`                      | `src/routes/browse.ts`             | Host 目录选择                 |
| `/api`                             | `src/routes/monitor.ts`            | 健康、状态和 Docker 构建      |
| `/api/messages`、`/api/follow-ups` | `src/web.ts`                       | 消息发送和 Follow-up          |

## 认证

Owner 私聊 Mem0 设置使用登录 Cookie，只能读取和修改本人配置：

- `GET /api/mem0-private` 返回 `credentialConfigured` 和本人活动 Dot 的策略，不返回密钥。
- `PUT|DELETE /api/mem0-private/credential` 保存或移除本人密钥；移除会撤销未发送的记忆操作。
- `PUT /api/mem0-private/dots/:profileId` 显式保存该 Dot 的总开关、召回与捕获开关；其他 owner 的 Dot 返回 `404`。

首发仅 Node Durable owner 私聊执行 Mem0 请求；配置不为 Group、渠道、Goal、Handoff 或 Cloud 增权。参见 [当前覆盖与限制](mem0-owner-private.md)。

Durable Session approvals use authenticated `GET /api/groups/:jid/sessions/:sessionId/approvals` and `POST /api/groups/:jid/sessions/:sessionId/approvals/:approvalId`. A decision requires `{ parametersDigest, decision: "approve" | "deny", requestId }`; it is bound to the exact displayed intent and current owner/workspace/Host policy. `GET .../artifacts/:artifactId` returns verified completed content only. Unknown/conflicting decisions return `409`; no approval is inferred from retries or model output. These APIs currently authorize only exclusive private-artifact creation, not arbitrary tool writes.

With both Goal and Durable rollout flags enabled, `POST /api/goals` in an authorized Host workspace without a supplied Session atomically provisions its Session/task and returns the existing Scheduler's initial run receipt. The original creation key is retained across retries. `GET /api/goals/:id` includes frozen execution snapshots, verified artifact evidence and `managed_execution`; default managed delivery is the owned Session/workspace. Pause retains the original run, resume reclaims it, and cancel revokes pending consent. Natural-language completion requires explicit revision-bound confirmation after verified evidence exists; literal `artifact_contains:TEXT` conditions are evaluated against the actual artifact. Existing non-Durable/manual tasks retain their previous APIs.

### Durable 产品 Session（可选 Host rollout）

`MINICLAW_DURABLE_RUNTIME=true` 仅影响新建的已授权 Host conversation Session。现有、主会话及 Docker 会话继续原执行路径，已创建 Session 的引擎不随开关或重启改变。创建 `/api/groups/:jid/sessions`（兼容 `/agents`）可携带 `requestId` 或 `Idempotency-Key`；同一标识和参数返回同一会话，不同参数返回冲突。

正式 `POST /api/messages` 对 Durable Session 要求稳定 `requestId`（或请求头），绑定完整执行参数，返回 `messageId`、`submissionId`、`runtime: pi-durable` 等回执。结果不确定时只用原标识查询或重试。附件、旧 WebSocket 直接发送和 `/clear` 暂不支持，不会降级到 Coding Agent 执行。

- `GET /api/groups/:jid/sessions/:sessionId/runtime`：授权的产品回执、Goal、审批、进程 `epoch`、持久化 `revision` 及已提交 `live`（实际运行、模型文本、工具状态、队列与摘要）；失败输入还会返回脱敏后的 `failure`（`kind`、HTTP `status`、短消息、`retryable`、处理建议），费用状态仍为 `unpriced`。WebSocket 的 `durable_session_update` 携带 `epoch`、`revision`，并可以附带小块 `progress`（状态、当前工具、部分文本、待确认数量、最新失败）。客户端用 progress 更新当前可见状态，断线重连后仍重新获取完整快照；revision 不是跨库原子事务。
- `POST /api/groups/:jid/sessions/:sessionId/abort`：当前主人中止 Conversation，包括其排队输入；原有 virtual-JID `/interrupt` 也路由到实际 Durable executor。
- `POST /api/groups/:jid/sessions/:sessionId/controls`：`{requestId, command}`；command 使用快照的 `expectedQueueDigest`，支持 `edit`（submissionId/content）、`cancel`（submissionId）、`steer`（submissionId）、`reorder`（完整 submissionIds）及 `abort`（确切 taskId）。返回稳定 `{control:{id,requestId,state:applied|rejected}}`；队列或目标变化记为 rejected，不修改执行。重试必须保留原完整参数和 requestId；更改参数返回 409。
- `controls` 的 abort 只标记该 taskId，旧请求不会中止后来的运行；兼容 `/abort` 与 virtual-JID `/interrupt` 仍按 Conversation 范围中止并撤回排队输入。内部 write 不能编辑或移动。
- 旧 follow-up 编辑/排序控制在 Durable Session 上继续返回冲突；应使用上述实际 Durable Inbox 控制。敏感操作目前仅支持确切内容的私有产物审批，不包含邮件、远程修改等通用外部写入。

这些接口使用现有登录和 Workspace/Host 权限。模型读取现有 Provider 配置；OpenAI Completions 可在 Provider advanced `customEnv` 配置 `MINICLAW_MODEL_API=openai-completions`，默认是 `anthropic-messages`。仅支持 API-key，OAuth/完整 Skills/MCP/Docker 适配仍待实现。当前 Durable 费用未计价、未纳入费用统计，不能视为免费。

### Personal Goals（可选）

`GET /api/goals/availability` 需要登录，返回是否启用。其余接口要求服务设置
`MINICLAW_PERSONAL_GOALS=true`；未启用时返回 `404`。

- `GET /api/goals`：仅列出本人且仍有 Workspace 权限的目标。
- `POST /api/goals`：创建目标，必须携带 `Idempotency-Key`，同键不同内容返回 `409`。
- `GET /api/goals/:id`：目标、关联步骤、原 Scheduler 执行记录和活动历史。
- `PATCH /api/goals/:id`：更新字段/状态，要求 `expected_revision`；终态不可重开。
- `POST /api/goals/:id/tasks`：以 `task_id` 和 `expected_revision` 关联本人同工作区、
  无活跃运行的已暂停 Agent 任务。一个任务仅能关联一个目标。
- `POST /api/goals/:id/tasks/:taskId/run`：由原 Scheduler 触发运行，要求
  `Idempotency-Key` 和 `expected_task_revision`；返回可重取的 `runId`/执行回执。

Goal 的 `budget_max_runs` 限制真正跨过 Scheduler 执行边界的次数，不是 token 或金额
预算。暂停/取消会先建立执行栅栏；停止当前运行失败时，返回 `409 GOAL_STOP_PENDING`
且目标保持 `paused`，不会虚报取消完成。完整字段与边界见
[Goals and tasks](personal-agent/goals-and-tasks.md)。

Public：

- `GET /api/auth/status`
- `POST /api/auth/setup`，仅用户表为空时可用
- `POST /api/auth/login`
- `GET /api/auth/register/status`
- `POST /api/auth/register`
- `GET /api/auth/avatars/:filename`

登录后：

- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PUT /api/auth/profile`
- `PUT /api/auth/password`
- `GET /api/auth/sessions`
- `DELETE /api/auth/sessions/:id`
- `POST /api/auth/avatar`

`MINICLAW_DEMO_OPEN=true` 时，回环地址上的未登录请求由服务端会话中间件签入管理员，浏览器不必先访问 `/login`。默认关闭。`/api/cloud-runtime` 仍只接受 HMAC，不接受这个 Cookie。说明见 [DEMO.md](../DEMO.md)。

## 工作区、消息和运行控制

- `GET|POST /api/groups`
- `PATCH|DELETE /api/groups/:jid`
- `PATCH /api/groups/:jid/agent-profile`
- `POST /api/groups/:jid/stop`
- `POST /api/groups/:jid/interrupt`
- `POST /api/groups/:jid/reset-session`
- `POST /api/groups/:jid/clear-history`，重建工作区内容：永久清除聊天、
  Runtime Session、子对话、工作目录及 Workspace Memory（含版本历史和
  Home Owner Profile），关联定时任务停止并移入回收站；保留工作区外壳、
  `data/extra/` 和任务运行历史
- `POST /api/groups/:jid/reset-owner`，admin break-glass
- `GET /api/groups/:jid/messages`
- `DELETE /api/groups/:jid/messages/:messageId`
- `GET|PUT /api/groups/:jid/env`
- `GET|PUT /api/groups/:jid/mcp`，仅兼容旧客户端
- `POST /api/messages`
- `GET /api/follow-ups`
- `POST /api/follow-ups/:messageId/action`

`POST /api/messages` 可以携带 Web 附件和 Runtime Session 标识。`/clear` 会进入与
`reset-session` 相同的 owner 级破坏性检查。

`POST /api/groups` 和 `PATCH /api/groups/:jid` 接受 `interaction_mode`
（`assistant` 或 `proactive`），两者的响应体都会回显当前值。该字段存放在
Workspace↔AgentProfile 绑定行上，因此：仅 `web:` 前缀工作区可修改，否则 403；
工作区没有 AgentProfile 绑定时返回 409 `WORKSPACE_AGENT_PROFILE_MISSING`。
它与 `execution_mode` 共享同一道 quiesce 边界，暖 Runner 只能观察到旧契约或新
契约；停机失败返回 503 并带 `persisted` 标记。

Home Workspace 固定归属当前用户的内置 Miniclaw。尝试通过
`PATCH /api/groups/:jid/agent-profile` 将 Home 迁移到自定义 Agent 时返回：

```json
{
  "error": "Home Workspace 始终属于内置 Miniclaw，不能迁移到自定义智能体",
  "code": "HOME_WORKSPACE_AGENT_IMMUTABLE"
}
```

HTTP 状态为 409；请求不会停止现有 Runner，也不会修改绑定。

创建 Docker 工作区时，当前有效的管理员可以在 `POST /api/groups` 中提交
`additional_mounts`（最多 8 项）：

```json
{
  "name": "数据分析",
  "execution_mode": "container",
  "additional_mounts": [
    {
      "host_path": "/srv/datasets",
      "container_path": "datasets",
      "readonly": true
    }
  ]
}
```

`host_path` 是 Miniclaw/Docker 守护进程所在服务器上的绝对目录，不是浏览器
所在设备的目录；`container_path` 是 `/workspace/extra/` 下的相对路径。来源目录
必须通过 `config/mount-allowlist.json`，目标不能重复、嵌套、穿越或覆盖运行时
保留目录。普通用户、停用管理员和 host 模式请求都会被拒绝。权限、allowlist、
真实路径与目录类型会在每次容器启动前重新校验，因此管理员被降权、目录被删除、
符号链接被替换或策略收紧后，旧配置不会继续生效。管理界面使用
`GET /api/browse/directories?purpose=mount` 浏览服务器目录；未配置有效 allowlist
时该入口 fail-closed。

## 文件

- `GET|POST /api/groups/:jid/files`
- `POST /api/groups/:jid/files/open-directory`
- `GET /api/groups/:jid/files/download/:path`
- `GET /api/groups/:jid/files/preview/:path`
- `GET|PUT /api/groups/:jid/files/content/:path`
- `DELETE /api/groups/:jid/files/:path`
- `POST /api/groups/:jid/directories`

路径必须位于目标工作区允许范围内；系统目录、路径穿越和不安全符号链接会被拒绝。

## Runtime Session 与渠道绑定

推荐使用 `/sessions` 语义：

- `GET|POST /api/groups/:jid/sessions`
- `PATCH|DELETE /api/groups/:jid/sessions/:sessionId`
- `PUT /api/groups/:jid/sessions/:sessionId/im-binding`
- `DELETE /api/groups/:jid/sessions/:sessionId/im-binding/:imJid`

`/agents` 是同一模型的历史兼容别名：

- `GET|POST /api/groups/:jid/agents`
- `PATCH|DELETE /api/groups/:jid/agents/:agentId`
- `PUT /api/groups/:jid/agents/:agentId/im-binding`
- `DELETE /api/groups/:jid/agents/:agentId/im-binding/:imJid`

群聊绑定到工作区：

- `POST /api/groups/:jid/im-groups/sync`
- `GET /api/groups/:jid/im-groups`
- `PUT /api/groups/:jid/im-binding`
- `DELETE /api/groups/:jid/im-binding/:imJid`

约束：

- 工作区绑定只接受群聊。
- Runtime Session 绑定只接受私聊。
- 飞书话题群和需要 @ 激活的普通群使用 `thread_map`，每个原生上下文映射独立
  Runtime Session。
- 请求必须携带或解析出正确的 `channel_account_id`，不能跨机器人账号绑定。

## Agent Profiles

- `GET|POST /api/agent-profiles`
- `POST /api/agent-profiles/generate`
- `PATCH|DELETE /api/agent-profiles/:id`
- `POST|DELETE /api/agent-profiles/:id/avatar`
- `POST /api/agent-profiles/:id/refine-prompt`
- `GET /api/agent-profiles/:id/workspaces`
- `GET /api/agent-profiles/:id/prompt-versions`
- `POST /api/agent-profiles/:id/prompt-versions/:version/restore`
- `POST /api/agent-profiles/:id/effective-capabilities`

`effective-capabilities` 返回 PromptPlan、Skill/MCP Manifest、上下文预算和最近一次
脱敏运行快照，用于对比“配置预期”与“SDK 实际加载”。

`POST /api/agent-profiles` 只创建隔离的 AgentProfile。它不会隐式创建 Workspace、
Session 或 Memory，也不会绑定/复制 Home Workspace。用户必须在创建 Workspace 时
显式选择它，或通过上面的非 Home Workspace 迁移接口建立归属。内置 Miniclaw 的
代码级平台身份不存放在这些可编辑的 Prompt 字段中，自定义 Agent 不会继承。

## Agent-first 工作区投影

- `GET /api/workspaces`
- `GET /api/workspaces/mounts`
- `GET /api/workspaces/:jid`
- `GET /api/workspaces/:jid/runtime-sessions`
- `GET /api/workspaces/:jid/channel-mounts`

这些接口是 `registered_groups` 兼容存储之上的只读产品投影。

### Miniclaw Owner Profile

- `GET /api/workspaces/:jid/owner-profile`
- `PATCH /api/workspaces/:jid/owner-profile`

只允许该用户不可删除的 Home Workspace、内置默认 Miniclaw AgentProfile 和实际
owner。无权访问、自定义 Agent 或非 Home 目标统一返回 404。

PATCH 使用 action 联合类型：

```json
{
  "action": "set",
  "preferredAddress": "小何",
  "expectedRevision": 0,
  "idempotencyKey": "owner-address-first-set"
}
```

首次设置的 `expectedRevision` 可省略或为 `0`；已有/已清空值必须先 GET，并携带返回
的当前 `revision`。修改成功会在同一事务中完成 onboarding。清空不会重置冷启动：

```json
{
  "action": "clear",
  "expectedRevision": 3,
  "idempotencyKey": "owner-address-clear-3"
}
```

owner 明确拒绝首次设置时可提交
`{"action":"skip","expectedOnboardingRevision":1}`。CAS 过期或从未设置却执行 clear
返回 409 `revision_conflict`；重复 idempotency key 对应不同请求返回 409。

称呼底层复用保留的 Workspace Memory revision/provenance/audit/outbox，但不属于
通用 Memory API：`miniclaw.owner.preferred_address` 不能通过通用接口创建、更新或
忘记，也不会出现在通用读取、搜索、versions 或 Runtime snapshot 中。

## 工作区项目能力

- `GET /api/groups/:jid/workspace-config/skills`
- `POST /api/groups/:jid/workspace-config/skills/install`
- `PATCH|DELETE /api/groups/:jid/workspace-config/skills/:id`
- `GET|POST /api/groups/:jid/workspace-config/mcp-servers`
- `PATCH|DELETE /api/groups/:jid/workspace-config/mcp-servers/:id`

读操作要求访问工作区，写操作要求工作区 owner。

## 渠道账号

- `GET|POST /api/channel-accounts`
- `GET|PATCH|DELETE /api/channel-accounts/:id`
- `POST /api/channel-accounts/:id/test`
- `POST /api/channel-accounts/:id/toggle`
- `POST /api/channel-accounts/:id/onboarding`
- `GET /api/channel-accounts/:id/onboarding/status`
- `POST /api/channel-accounts/:id/onboarding/verify`
- `POST /api/channel-accounts/:id/pairing-code`
- `GET /api/channel-accounts/:id/paired-chats`
- `DELETE /api/channel-accounts/:id/paired-chats/:jid`
- `POST /api/channel-accounts/:id/disconnect`
- `POST /api/channel-accounts/:id/logout`

账号严格按 `owner_user_id` 隔离。同一 Provider 可以有多个账号，每个账号可以选择
默认工作区。

## Provider 与系统配置

Provider：

- `GET /api/config/claude`
- `GET|POST /api/config/claude/providers`
- `PATCH|DELETE /api/config/claude/providers/:id`
- `PUT /api/config/claude/providers/:id/secrets`
- `POST /api/config/claude/providers/:id/toggle`
- `POST /api/config/claude/providers/:id/reset-health`
- `GET /api/config/claude/providers/health`
- `GET /api/config/claude/providers/:id/usage`
- `PUT /api/config/claude/balancing`
- `POST /api/config/claude/apply`
- `POST /api/config/claude/oauth/start`
- `POST /api/config/claude/oauth/callback`
- `PUT /api/config/claude/custom-env`

系统：

- `GET|PUT /api/config/system`
- `GET|PUT /api/config/host-integration`，仅 admin；包含
  `adminHostOnlyMode`。从 `false` 切到 `true` 时会停稳管理员工作区运行器，并把
  active admin 拥有的工作区和定时任务持久迁移为 Host；普通成员数据不变
- `GET /api/config/external-resources`
- `GET /api/config/external-resources/rule`
- `GET|PUT /api/config/registration`
- `GET|PUT /api/config/appearance`
- `GET /api/config/appearance/public`，Public
- `POST|DELETE /api/config/appearance/avatar`

Legacy 渠道 facade 位于 `/api/config/user-im/*`，涵盖飞书、Telegram、QQ、钉钉、
微信、Discord 和 WhatsApp。它们继续服务旧数据和旧客户端；新 UI 与新功能使用
`/api/channel-accounts`。

系统级 `/api/config/feishu` 和 `/api/config/telegram` 也只保留兼容用途。

## 定时任务

- `GET|POST /api/tasks`
- `GET /api/tasks/attention`：当前用户被阻断或等待确认的持久工作，不依赖 Personal Goals

`MINICLAW_DURABLE_MAIN=true`（同时需要 `MINICLAW_DURABLE_RUNTIME=true` 和 Host 工作区）让还没有助手回复的主会话改走 Pi Durable，并在界面上打开那条对话。已经有编码助手回复的主会话保持原路径。`MINICLAW_CLOUD_MAX_MODEL_STEPS` 可把新的 Cloud 会话步数上限从 24 调到 1–64。自动批准的只读电脑调用不计入每会话 100 条 MCP 审批上限。

- `PATCH|DELETE /api/tasks/:id`
- `POST /api/tasks/:id/restore`
- `POST /api/tasks/:id/runs`
- `GET /api/tasks/:id/runs`
- `GET /api/tasks/runs/:runId`
- `POST /api/tasks/runs/:runId/cancel`
- `POST /api/tasks/:id/run`，旧立即运行入口
- `GET /api/tasks/:id/logs`，旧日志入口
- `POST /api/tasks/ai`
- `POST /api/tasks/parse`

写入使用 revision 或 idempotency key 防止并发覆盖和重复运行。运行状态与通知状态
分开持久化；通知失败不会重新执行任务主体。

任务定义不设置每用户数量配额。`prompt` 与 `script_command` 有长度上限，AI 输入
和解析结果、REST 与 MCP `schedule_task` / `update_task` 使用同一组上限，超出即
拒绝。

PATCH 修改 `chat_jid` 时会同时更新任务的具体 `delivery_route_jid`。已经物化的 Run
在 `definition_snapshot` 中冻结原投递路由，不会因后续任务编辑而切换目标。

## Skills、MCP 和 Plugins

Skills：

- `GET /api/skills`
- `GET /api/skills/search`
- `GET /api/skills/search/detail`
- `POST /api/skills/import/git`
- `POST /api/skills/import/archive`
- `GET|PATCH|DELETE /api/skills/:id`
- `DELETE /api/skills/user-all`
- `POST /api/skills/install`
- `POST /api/skills/:id/reinstall`

MCP：

- `GET|POST /api/mcp-servers`
- `GET|PATCH|DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/sync-host`

Plugins：

- `GET /api/plugins`
- `PATCH /api/plugins/enabled/:pluginFullId`
- `POST /api/plugins/materialize`
- `DELETE /api/plugins/marketplaces/:name`，只清理调用者自己的启用引用
- `GET /api/plugins/commands`
- `GET /api/plugins/catalog`
- `GET /api/plugins/catalog/marketplaces/:mp`
- `POST /api/plugins/catalog/scan`，admin

已删除的旧 Plugin 接口不得重新引用：

- `POST /api/plugins/sync-host`
- `GET /api/plugins/available-on-host`

## Workspace Memory v2

Workspace Memory 是 Workspace 范围内、跨 Session 复用的结构化知识。客户端必须先从
`GET /api/workspaces` 的 `workspaces[].jid` 取得 Workspace JID，再把它作为
`:workspaceJid`；不能使用 `folder` 代替。路径参数需要 URL 编码。

### 读取与搜索

- `GET /api/memory/workspaces/:workspaceJid/items`
  - Query：`status`、`kind`、`limit=1..100`、`cursor` 均可选。
  - 返回 `{ storeRevision, items, nextCursor }`。
- `GET /api/memory/workspaces/:workspaceJid/items/search`
  - Query：必填 `q`，可选 `kind`、`limit=1..100`。
  - 返回 `{ storeRevision, hits: [{ item, rank, snippet }] }`。
- `GET /api/memory/workspaces/:workspaceJid/items/:itemId`
  - 返回 `{ storeRevision, item }`。
- `GET /api/memory/workspaces/:workspaceJid/items/:itemId/versions`
  - Query：可选 `limit=1..100`、`cursor`。
  - 返回 `{ storeRevision, itemId, versions, nextCursor }`，按 revision
    从新到旧排列。

`kind` 为 `fact | decision | lesson | open_loop`。`status` 为
`active | proposed | conflicted | superseded | deleted`。Memory item 的主要字段：

```json
{
  "id": "mem_...",
  "workspaceJid": "web:...",
  "kind": "decision",
  "title": "采用 SQLite",
  "content": "Workspace Memory 以 SQLite 为唯一真相源。",
  "canonicalKey": "memory-store",
  "status": "active",
  "importance": 0.9,
  "confidence": 1,
  "validFrom": null,
  "validUntil": null,
  "expiresAt": null,
  "revision": 2,
  "createdAt": "2026-07-28T08:00:00.000Z",
  "updatedAt": "2026-07-28T09:00:00.000Z",
  "deletedAt": null,
  "provenance": {
    "sourceType": "web_user",
    "sourceId": null,
    "sessionId": "session-id",
    "observedAt": "2026-07-28T08:30:00.000Z"
  }
}
```

Version 还包含 `changeType: create | update | forget` 和
`actor: { type, id }`，用于展示修订来源；历史版本不可通过 API 原地修改。

### 创建、编辑与忘记

- `POST /api/memory/workspaces/:workspaceJid/items`
- `PATCH /api/memory/workspaces/:workspaceJid/items/:itemId`
- `DELETE /api/memory/workspaces/:workspaceJid/items/:itemId`

创建请求必须包含 `kind` 和非空 `content`，可以包含 `title`、`canonicalKey`、
`status`、`importance`、`confidence`、有效期字段、`provenance` 和
`idempotencyKey`。Web 客户端不能提交 `sourceType` 或 writer 身份；服务端根据认证
上下文生成它们。示例：

```json
{
  "kind": "lesson",
  "title": "迁移前先验证备份",
  "content": "恢复演练通过后再切换生产数据。",
  "importance": 0.8,
  "provenance": {
    "sessionId": "session-id",
    "observedAt": "2026-07-28T08:30:00.000Z"
  },
  "idempotencyKey": "client-generated-stable-key"
}
```

PATCH 至少包含一个可修改的 Memory 字段，并必须携带当前
`expectedRevision`。DELETE 表示“忘记”：写入 tombstone/修订历史，而不是删除来源
Session；请求体必须包含 `expectedRevision`，可选 `reason`、`provenance` 和
`idempotencyKey`。

```json
{
  "expectedRevision": 2,
  "reason": "Outdated product decision",
  "provenance": {
    "observedAt": "2026-07-28T10:00:00.000Z"
  }
}
```

POST、PATCH 和 DELETE 均返回
`{ storeRevision, item, replayed }`；GET item 返回相同 wrapper，但不含
`replayed`。`replayed` 表示服务端按相同 idempotency key 返回了已有写入结果。

并发编辑使用 compare-and-set。`expectedRevision` 过期时返回：

```json
{
  "error": "revision_conflict",
  "currentRevision": 3,
  "storeRevision": 9
}
```

客户端必须保留用户草稿并让用户显式加载最新版，不能盲目重试覆盖。相同
idempotency key 被不同请求复用时返回 409 `idempotency_conflict`。校验失败返回
400；无权访问和不存在统一返回 404，避免泄露 Workspace 是否存在。

旧的 `/api/memory/sources`、`/api/memory/search`、`/api/memory/file` 和
`/api/memory/global` 已退役并返回 410。旧文件只保留用于显式离线导出/迁移，
Web 和 Runtime 不再把它们当作第二个可写真相源。

完整产品边界与交互约定见
[Workspace Memory v2](workspace-memory-v2.md)。

## 用量与计费

用量：

- `GET /api/usage/stats`
- `GET /api/usage/models`
- `GET /api/usage/filters`
- `GET /api/usage/records`
- `GET /api/usage/export.csv`
- `GET /api/usage/users`

计费用户侧：

- `GET /api/billing/status`
- `GET /api/billing/plans`
- `GET /api/billing/my/subscription`
- `GET /api/billing/my/balance`
- `GET /api/billing/my/usage`
- `GET /api/billing/my/usage/daily`
- `GET /api/billing/my/transactions`
- `GET /api/billing/my/quota`
- `GET /api/billing/my/access`
- `POST /api/billing/my/redeem`
- `PATCH /api/billing/my/auto-renew`
- `POST /api/billing/my/cancel-subscription`

计费管理接口位于 `/api/billing/admin/*`，统一要求 `manage_billing`。

## 管理、监控与问题报告

管理：

- `GET|POST /api/admin/users`
- `PATCH|DELETE /api/admin/users/:id`
- `POST /api/admin/users/:id/restore`
- `DELETE /api/admin/users/:id/sessions`
- `GET /api/admin/permission-templates`
- `GET|POST /api/admin/invites`
- `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET /api/admin/audit-log/export`

监控：

- `GET /api/health`，Public
- `GET /api/status`
- `POST /api/status/groups/:folder/switch-provider`
- `GET /api/status/channel-outbox/uncertain`
- `POST /api/status/channel-outbox/:id/resolve`
- `POST /api/docker/pull`

Agent 镜像只由 `main` 分支的 GitHub Actions 构建并发布。该接口仅在运行主机上执行
`docker pull` 更新已发布镜像，不在用户机器上编译镜像。

投递结果不确定的 outbox 记录会围栏住整个 Turn，运行时无法自行判定，只能由人工
确认后放行。`resolve` 使用 `expectedRevision` 做 compare-and-set，取值为
`delivered`（需要 `providerMessageId`）或 `failed`；revision 过期返回 409，
调用方必须重新读取后再决定，不能盲目重试。列表不返回 payload。

问题报告：

- `GET /api/bug-report/capabilities`
- `POST /api/bug-report/generate`
- `POST /api/bug-report/submit`

目录浏览：

- `GET|POST /api/browse/directories`

## WebSocket

`/ws` 在 Upgrade 时校验 Cookie Session 和 Origin。

客户端主要操作：

- `send_message`
- `terminal_start`
- `terminal_input`
- `terminal_resize`
- `terminal_stop`

服务端主要事件：

- `new_message`
- `agent_reply`
- `typing`
- `status_update`
- `stream_event`
- `agent_status`
- `terminal_output`
- `terminal_started`
- `terminal_stopped`
- `terminal_error`
- `docker_pull_log`
- `docker_pull_complete`

精确联合类型和字段以 `src/web.ts`、`src/types.ts` 与 `shared/stream-event.ts` 为准。

### Personal Device Nodes（可选）

`MINICLAW_DEVICE_NODES=true` 允许新配对、身份审批、工作区文件授权和新工具操作。
已提交操作恢复与撤销不依赖开关。见 [设备协议与本地节点](personal-agent/device-nodes.md)。

- Cookie 主人：`GET /api/device-nodes[/availability|/audit]`，`POST /pair-tickets`、`/:id/approve`、`/:id/grants`、`/:id/revoke`、`/grants/:id/revoke`（均在此前缀下）。写操作要求 `Idempotency-Key`；审批/撤销设备要求当前 `expected_revision`；授权/审批/撤销要求 `confirmed:true`。声明不自动授予权限。
- 单次配对码：`POST /api/device-nodes/join`。真实主人由票据决定，不接受节点指定 owner。
- 专用节点 Bearer：`POST /api/device-nodes/transport/heartbeat`、`GET /transport/commands`、`POST /transport/result`。Cookie 不能代替节点令牌，节点令牌不能登录普通 API。
- Session 权威快照包含 `device_commands` 元数据，文件正文不进入快照或节点审计；正文仅进入已授权的 Tool 结果、私有节点回执和产品执行持久化。

### Cloud Runtime 私有回调（schema v79，内部基础设施）

`src/routes/cloud-runtime.ts` 接入现有权限与加密 Provider，不提供用户登录或
新的业务 Session 创建入口。Cookie 无效；必须签名确切方法、路径、请求体、
用户/Workspace/Session/runtime/fingerprint 和有效期，DO ID 位于签名路径中。

- `POST /api/cloud-runtime/:session/objects/:object/policy`：
  `{binding_digest,gateway_origin}`，再次检查当前权限，首次通过时原子绑定 DO 身份。
- `POST /api/cloud-runtime/:session/objects/:object/inputs`：
  `{input:{request_id,content,when_busy,product_receipt_digest},native:{submission_id,status}}`，
  将原始完整产品回执绑定到实际 Native Submission；恢复时缺失或领先的回执拒绝执行。
- `POST /api/cloud-runtime/:session/objects/:object/model/:attempt`：
  OpenAI Completions 流式请求；仅指定模型和绑定允许的工具（默认 `inspect_text`），令牌/字节/时间及
  持久化尝试预算有界。重复 attempt 拒绝再次调用供应商，不返回密钥或原始上游错误。

内部 Cloud placement 与 Session 在同一产品事务创建，已运行 Node 会话不可被接管。
Node Harness 拒绝 Cloud placement。`MINICLAW_CLOUD_RUNTIME=true` 时，现有 Session
创建接口可显式传 `runtime: "cloudflare-durable"`，并复用消息、快照与控制接口；
`runtime_kind` 保持兼容，`runtime_router` 标识执行所有者。新开关不改写历史 Session。
`GET /api/groups/:jid/session-runtimes` 仅向 Workspace 所有者列出可用选项。
私有 `.../controls` 校验原控制回执，`.../results` 幂等回写原生完成结果，均使用相同
对象/身份/HMAC 边界。授权到期后只读历史与结果交付不授予新执行权。
私有 `.../tools` 接受原生宿主生成的 `{id,conversation_id:1,task_id,call_id,name,
parameters,parameters_digest}`，当前支持按新 Session 能力与开关授权的
`read_personal_memory`，以及 `create_approved_artifact` 的
`probe/propose/status/execute` 阶段。前者保留逐条修订授权与审计；后者绑定原生
任务/代次/调用和精确内容审批，不接受自选文件路径。私有
`.../approval-decisions` 仅请求重新核对已有审批，不授予批准权限。
原 Cookie 审批接口在提交决定后发送唤醒；失败时返回 `runtimePending`，由原 DO Alarm
恢复。快照的 `runtimeWaits` 与 `executionState` 展示持久等待/阻断状态。
Goal 云端执行与本地设备工具桥接尚未开放。见 [云端部署边界](personal-agent/cloudflare-deployment.md)。

v79 增加后端 Goal 执行授权账本，尚不开放 Goal 的 Cloud 创建入口。受管理的
私有请求必须携带 `{goal_id,run_id,context_digest}` 执行引用。`policy` 同时核对
`execution_grant_digest`；模型请求使用 `{execution,request:<OpenAI 请求>}`，
仅内层请求交给现有加密 Provider。`inputs.input` 与 `tools` 的执行引用必须与原始
产品回执/持久化授权一致。模型尝试、执行关联及两个预算计数在同一事务提交。
普通 Cloud 会话保留原请求体、绑定和额度，不能通过附加执行引用获得 Goal 权限。
这不是新的浏览器授权 API；Worker 与 Scheduler 的完整 Goal 交接仍待实现。

### Bot Groups（可选）

`MINICLAW_BOT_GROUPS=true` 启用新建、发送与授权配置；关闭后保留已有群读取、归档与撤销。
`GET /api/bot-groups` 列出当前成员可访问的群；`/availability` 返回准入开关，
`/options` 只返回本人当前可用的 Profile/Workspace 配置选项。
`POST /api/bot-groups` 使用 `{name,bot_profile_ids?,workspace_jid?,description?}` 创建独立内部 UUID 群。
前端支持多选 Dot；`bot_profile_ids` 为 1–49 个本人可用 Profile UUID，去重排序后与群主原子加入。
省略该字段保留旧客户端默认 Dot 行为；省略 `workspace_jid` 由服务端优先选择本人可访问的 Home，
再选择已有 Web 工作区作为存储关联，普通建群不再要求选择“对话环境”。执行可用时，服务端使用所选 Dot 已有配置补齐基础文本对话，默认工具为空；模型未就绪不阻止保存名单。
普通聊天和开启讨论无需逐个配置范围/模型授权；文件与工具等额外能力仍通过高级设置单独授予。
`GET /api/bot-groups/:id?before_seq=N&limit=50` 返回权威快照与有序分页，含 epoch/revision/last_seq。
`POST .../:id/messages` 使用 `{content,mentions?:profileId[]}`；作者来自登录身份。
`POST .../:id/members` 添加已有用户或本人 Bot；`PATCH .../:id/members/:memberId` 更新状态/角色/范围。
`PATCH .../:id` 更新名称/说明或归档。配置变更要求 `expected_revision`。
所有写入要求 `Idempotency-Key`，同用户同键绑定完整操作、群与参数；重复提交返回原始回执与当前快照。
WebSocket `bot_group_update` 只传 ID/版本作为刷新提示；成员移除有最小化 `bot_group_access_revoked` 提示。
成员身份不授予 Workspace 或工具权限；单独开启群聊时不执行模型。
可选 `MINICLAW_BOT_HANDOFFS=true` 开启群主原生任务：`messages` 增加可选 `dispatch`（false 为普通消息），未选目标时交给 Chief，显式 @ 或 `mentions` 最多两个目标。
`POST .../:id/members/:memberId/runtime-grants` 以群/成员版本、`runtime_kind: node-durable`、工具白名单、模型请求上限和有效分钟建立独立授权。
`POST .../:id/handoffs/:handoffId/control` 以任务版本执行 start/pause/resume/cancel。
`POST .../:id/handoffs/:handoffId/abort` 以任务版本、`task_id`、`queue_digest` 提交现有原生精确终止协议。
`GET .../:id/handoffs/:handoffId/approvals` 仅群主且当前 Native Workspace 权限有效时读取审批；同路径 `/:approvalId` POST 指定 `parameters_digest` 和 approve/deny。
`POST .../:id/handoffs/:handoffId/delegations` 接受完成的 Chief 任务、`target_bot_ids`、指令和任务版本；这是群主明确确认的受控委派。
以上写入复用同一幂等回执。独立默认关闭的 `MINICLAW_CLOUD_BOT_HANDOFFS=true`（同时需要 Groups/Handoffs/Cloud Runtime 准入及有效网关配置）允许显式 `runtime_kind: cloudflare-durable`，不回退执行器。Cloud 默认无工具，仅可审查授权 `inspect_text` 和另行开启的 `create_approved_artifact`；拒绝本机文件工具。`availability` 的 `cloud_handoffs_enabled`、`cloud_approvals_enabled` 是准入开关状态，不是云端健康探测。关闭新准入保留既有云端会话、审批与回执。详见 [Cloud Bot teams](personal-agent/cloud-bot-teams.md) 与 [Handoff](personal-agent/bot-handoffs.md)。
删除所属 Workspace 会级联删除群及历史，操作前必须完成一致备份。详见
[Bot Groups](personal-agent/bot-groups.md)。

### Team product overview

`src/routes/team-overview.ts` mounts `GET /api/team-overview`. This authenticated,
private/no-store read snapshot aggregates existing owner Goals, readable Groups,
Bot activity and pending attention. Group membership does not expose another
owner's Goals, device requests or approvals. Host revocation is checked against
the current execution policy. It creates no runtime/input, scheduler or approval.
Attention links use existing Goal/Group controls; exact Cloud device permission
uses the existing device grant endpoint and original request ID.

Additive presentation fields include actual Goal run-budget counters and
participating Bot names/states, plus activity name/Group routing metadata.
Activity includes a Goal link only when that Goal is already visible to the
current owner. These are read-only projections, not planned step counts or
execution authority. Managed source envelopes use a human title in this view.

Bot Group member snapshots expose only the current display `avatar_emoji`,
`avatar_color` and `avatar_url`. Team activity/participants and linked Bot tool or
device attention can include the same display identity (`profile_id`, name and
avatar fields). This reuses existing snapshot authorization and avatar URLs; it
exposes no Profile prompts or grants. Goal review without a known Bot retains no
invented Bot identity. Revocation still removes access to the containing snapshot.

`GET /api/goals/team-options` returns only current owned active Groups with
scoped, available, reviewed Bot grants and an admitted Goal execution route.
These are display choices, not authority; creation and each execution boundary
revalidate live permissions. Optional `team.device_resources` (one paired device
and declared relative path) is immutable Goal intent and does not grant a read.
Both automatic and manual completion require its verified read receipt.

### Group discussion

Group snapshots include `discussion: { settings, run, current_task, awaiting }`. Messages add a
read-only `message_type` (`conversation` or `status`), while persisted `kind`,
`source` and historical digests are preserved. Runs expose an immutable
`protocol_version`: existing runs default to 1 and new relay runs use 2. The
runtime parser uses the original frozen turn contract; reconnect cannot upgrade
or downgrade it.
`PATCH /api/bot-groups/:id/discussion-settings` requires the current owner,
`Idempotency-Key`, and `{ expected_revision, enabled, coordinator_profile_id,
participant_profile_ids, policy?, max_turns?, max_turns_per_dot?, max_model_attempts? }`.
`policy` defaults to `coordinator-v1`; the owner must select `relay-v1` to enable
deterministic initial member slots and reviewed peer nominations. Each run
snapshots its policy and persists its remaining queue. Settings edits affect
future runs only, and pending turns count toward allocated turn limits.
Settings default to disabled; enabling validates every selected member's live
runtime grant and Workspace scope. An undirected dispatched Group message then
atomically creates one discussion run. A further message sent while that run is
live is a canonical interjection in the same run, not a new root and not
`GROUP_DISCUSSION_BUSY`; the next context read reports it in
`user_interjection_ids`. A message sent after the run became terminal opens a
new run whose `continued_from_run_id` links the previous one. During a live run,
directed additions also join that same run. Outside it, coordinator mode retains
directed Handoff routing; relay mode admits participant-only mentions as initial
slots and falls back to existing Handoff routing for other directed requests.

`discussion.work` lists recent proposals and linked background outcomes. A
v2 `delegate` control creates a proposal only. The owner may
`POST /api/bot-groups/:id/discussion-work/:workId/decision` with
`Idempotency-Key` and `{ expected_revision, proposal_digest, decision:
"approve" | "deny" }`. Approval validates the live target grant and reserves the
reviewed tool/model scope; it reuses an independent Handoff Session. The Group
receipt owns idempotent replay. Returned native results may queue the original
requester once; stopped or exhausted runs do not gain a new budget or run.
`model_attempts` includes actual Group and worker generations;
`work_model_attempts` and `reserved_work_attempts` distinguish consumption from
reserved worker capacity. Stopping discussion cancels pending proposals and
continuations; already-approved independent work uses its existing Handoff
controls for separate cancellation.

`awaiting` lists Dots whose native turn is parked on a human approval or a
device result (`profile_id`, `session_id`, `reason`, `since`) while the Group
continues with other Dots. Each entry's `task` exposes the owner-visible
approvals for that Dot's own session; `current_task` is the same view for the
active speaker. Approvals are addressed by workspace and session, so a parked
Dot's consent is never merged into another session's task. A coordinator conclusion published while a Dot is parked is
provisional: the run stays `running` and closes only after the parked result
returns and the coordinator decides again.

`POST /api/bot-groups/:id/discussions/:runId/stop` requires the owner and
`Idempotency-Key`. It commits the cancel fence before joining the native abort,
then returns the existing `{ receipt, snapshot }` envelope. A successful HTTP
acknowledgement confirms the command receipt; inspect `discussion.run.stop_state`
for the native result: `stopping`, `stopped`, or `uncertain`. Native transport
failure keeps the fence and a durable coded failure; it does not claim successful
abort. Recovery and an owner retry join the same fenced Session. Finishing that
abort advances the Group revision so connected clients can read the confirmed
state. Separately approved work retains its own stop controls. Reconnect never
starts or stops execution. Limits, persistence and evidence categories are
documented in [Group discussion](personal-agent/group-discussion.md).

`POST /api/bot-groups/:id/discussions/:runId/members/:profileId/stop` is
owner-only and accepts strict `{ lease_id }` with `Idempotency-Key`. It is
available for bounded member Runs, not frozen serial/legacy runs. The lease
must identify exactly that Group, Run and Dot. The command fences only this
member, cancels its outstanding peer dependencies and revokes its pending
consent before joining the actual native Stop. Other members and independent
approved background work retain their authority. No shared cancellation epoch
is incremented and no native Task is declared completed by the intent transaction.

`discussion.member_tasks` projects `{ profile_id, lease_id, state, can_stop }`
for these Runs. `active` means participating in the Run, not that a model is
currently executing. `stopping`, `stopped` and `uncertain` describe the target's
native Stop acknowledgement; the whole-Run `stop_state` is unchanged. Details
expose the individual Stop/retry action. A lost response retains the original
command scope and key. Replaying an old Run's command only returns its original
receipt; it cannot cancel the same Session's newer Run. Only actual dependents
receive a frozen cancellation control, not a fabricated peer answer or a
broadcast that wakes idle members. Reconnect itself creates no command.

### Experimental Node member questions

Discussion settings additionally accept optional
`execution_contract: "serial-v1" | "member-inbox-v1"`. The default remains
`serial-v1`; existing frozen policies and queue-only turns are unchanged.
`MINICLAW_GROUP_MEMBER_INBOX=true` advertises the read-only
`discussion.member_inbox_available` flag and permits explicit member-mode
admission for exactly two Node participants. Disabling the flag stops new
admission while preserving reconciliation and Stop for existing runs.

The member contract uses the same Group × Dot Product Sessions, native
Submission receipts and canonical messages. Its `ask_group_dot` tool admits a
directed public question; ACK does not mean native consumption or reply.
Native final replies carry server-bound `in_reply_to` provenance. Sender,
scope, live grant and actual native source inputs cannot be supplied by a
client or model. Snapshot `awaiting` projects each member's own approval wait.
This contract does not grant extra workspace tools or Cloud support. Bounds,
recovery behavior and current validation limits are recorded in
[Node member Inbox](member-inbox-node-77.md).
Bounded Node/Cloud member runs require additional explicit opt-ins and frozen
Run grants; their scope is recorded in [Cloud member communication](member-cloud-78.md).

In opt-in bounded member runs, a queued user correction fences a question's
older native final. The original question remains pending until the correction
has a committed native answer; a distinct answer must prove the complete
original question was present in its frozen public input. The returned mail
retains the original `in_reply_to` and deadline while citing the actual corrected
input/Submission/Task/answer entry. No old input or answer receipt is rewritten.
