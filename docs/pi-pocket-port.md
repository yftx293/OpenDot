# Pi Pocket 特性移植：跨设备接续

本批次在 MiniClaw 的既有 Web、Electron、Pi Coding Agent 和服务端队列上增加移动接续能力，不引入第二套 Backend、数据库或消息队列。

## 已实现与复用

| 能力         | 本批次实现                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------- |
| 手机接续     | 新增“跨设备接续”面板，可生成主会话或指定子会话的链接                                        |
| 主会话定位   | `?session=main` 优先于该设备记住的子会话，不删除原有偏好                                    |
| iOS 独立窗口 | 路由创建前将规范会话链接转换为现有 Hash Router 入口                                         |
| 运行中追加   | 触屏按钮复用 `sendMessage` / `sendAgentMessage`，明确选择 Queue 或 Steer                    |
| 队列管理     | 保留输入区原有编辑、排序、删除、立即发送和服务端持久化，不另建队列                          |
| 断线恢复     | 切网、后台超过 5 秒后返回、BFCache 返回和连接超时后重建连接                                 |
| 状态接续     | 沿用服务端 `active_run_snapshot`、`stream_snapshot` 和队列刷新，补取可见会话的已保存消息    |
| 安装入口     | 捕获浏览器安装事件；无安装事件时显示系统菜单操作说明；保留既有 standalone manifest          |
| 本机通知     | 优先使用通知专用 Service Worker，兼容拒绝 `new Notification()` 的手机浏览器；默认不显示正文 |
| 私网接入     | `scripts/pocket-access.mjs` 检查 Tailscale，按显式参数开启私网 HTTPS 并输出无凭证二维码     |

## 使用

在新分支上沿用项目已有的依赖安装与构建步骤，启动 MiniClaw Backend。每台设备都连接同一个 Backend，并使用各自的登录 Cookie。

在 Backend 所在机器运行只读检查：

```bash
node scripts/pocket-access.mjs --check
```

确认 Tailscale 已安装并登录后，显式启用私网接入：

```bash
node scripts/pocket-access.mjs --serve
# Backend 使用不同端口时：
node scripts/pocket-access.mjs --serve --port 3456
```

脚本不会安装 Tailscale、替用户登录、启用 Funnel 或关闭 MiniClaw 登录。存在其他 HTTPS 443 目标、共享路径、TCP 转发或公开 Funnel 时，脚本拒绝改写配置。`TAILSCALE_BIN` 可指定已安装的 CLI 路径。

手机加入同一 Tailnet，打开输出的 HTTPS 地址并登录。然后在电脑上打开目标会话，点击“跨设备接续”。电脑通过 localhost 访问时，先在面板填写脚本输出的 HTTPS origin，再复制会话链接到已经登录的手机。

链接只保存工作区与会话标识，不携带 Cookie、API Key 或登录令牌。原有服务端权限检查继续生效。子路径部署沿用编译时 `BASE_URL`。

## 生命周期与可靠性边界

客户端连接与服务端任务分开管理。退出登录或卸载应用布局时仅 `disconnect()`；关闭面板、浏览器或连接不调用停止任务的接口。认证错误码 `1008` / `4001` 会禁止自动重连，只有新的显式 `connect()` 才能恢复。

客户端不缓存待发送命令用于自动重放。面板用同步锁防止连续点击；提交失败或回执不确定时保留文本，并提示先检查会话和队列。这不是跨设备提交或外部工具操作的 exactly-once 保证。

Queue / Steer 沿用 MiniClaw 已有服务端策略，本批次没有把现有中断/重排策略改成 Pi Durable 原生边界调度。

## PWA 与通知边界

仍保留原来的 Workbox 缓存退役流程。`web/public/sw.js` 不改动，应用首页、聊天 API 和凭证不增加离线缓存。

新增 worker 只注册在 `${BASE_URL}pocket-notifications/` 子作用域，使用 `updateViaCache: 'none'`。它没有 `fetch` 处理器，也不注册应用根作用域。不等待 `navigator.serviceWorker.ready`，因为聊天页面故意不受 worker 控制。

通知授权仅由点击触发。用户可关闭本机通知，跨标签页同步退出选择。通知不显示会话正文；点击只聚焦本应用或打开本应用聊天首页，不执行通知载荷中的任意 URL。

**这是页面仍运行时的通知，不是服务端 Web Push。** 浏览器关闭、移动操作系统挂起页面后不保证到达。此功能不应标为“离线推送”。

## 没有在本批次实现

- 没有引入 `@earendil-works/pi-durable`，没有执行引擎或历史会话迁移。
- 没有增加 Pi Durable 工具检查点、安全重放或进程重启后的任务恢复保证。
- 没有实现 VAPID、PushSubscription、服务端通知 outbox 或关闭浏览器后的 Web Push。
- 没有移植 Pi Pocket 的多人邀请、协作批注、Peek tiles、内置浏览器或 Lancet Guard。
- 没有自动部署到用户电脑/云主机，没有修改 Tailnet、账户权限或模型凭证。

电脑休眠或关机时，本机 Backend 无法持续工作。需要持续运行时，应将同一个 Backend 部署到常开机器。

## 验证

独立行为测试使用项目已有的 TypeScript 开发依赖，运行生产模块的转译输出，以及通知 worker 的隔离环境；不需要模型 Key、Tailscale 账户或真实推送服务：

```bash
node --experimental-vm-modules --test tests/pocket-features.node.mjs
```

`tests/pocket-features.test.ts` 将同一测试组接入现有 Vitest，不替换任何已有测试或检查。

在 Node.js 24.19.0 的云环境对该分支复跑验证：

- 41 项 Pocket 专项行为测试全部通过。
- `make typecheck`、`npm run build:all`、`npm run format:check` 通过；共享类型、Agent Runner prompt 和文档检查通过。
- Chromium 移动视口交互测试 9 项通过，使用环境提供的 Chromium 与 FFmpeg。
- 完整 Vitest：335 个测试文件通过；2,854 项通过，23 项按套件配置跳过。

这些测试没有连接真实手机、真实 Tailnet、真实通知推送或生产模型。Service Worker 测试在隔离 VM 中验证无 fetch/push handler 和安全点击行为；它不代表 iOS Safari 安装、锁屏唤醒或操作系统推送验收。Pocket 仍不是 Durable Runtime，客户端重连测试也不证明服务端任务能从进程崩溃恢复。

设备验收顺序：电脑发起任务；手机打开同一子会话；分别提交 Queue / Steer；切换手机网络；后台返回；验证两端最终呈现服务端队列和活动状态；登出后切网不得复活连接；确认手机安装、通知拒绝与通知关闭均不影响聊天。实际 Tailnet 与设备验收仍待执行。

## 参考

特性与交互参考：TannerMidd/pi-pocket（https://github.com/TannerMidd/pi-pocket）。本批次在 MiniClaw 内重新实现适配代码，没有复制其应用、字体、图标、模型凭证或认证默认值。

Tailscale CLI 参考：https://tailscale.com/docs/reference/tailscale-cli/serve 。MiniClaw 保留自己的登录与授权边界，不将 Tailscale 网络身份视为应用权限。
