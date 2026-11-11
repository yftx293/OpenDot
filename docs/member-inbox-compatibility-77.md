# #77：成员 Inbox 的兼容性决策与复现

状态：Phase 0 兼容性实验与选型结论已记录。后续 Node Product 实现和验证见
[Node 成员问答记录](member-inbox-node-77.md)。以下 Coding Session 实验本身不代表
Node Durable Inbox、Cloudflare 或真实供应商模型通过；#77、#78 不能仅凭本表关闭。

## 依赖边界

| 对象                    | 固定版本 / commit                                              | 本次用途                                            |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------- |
| 已安装 Coding SDK       | `@earendil-works/pi-coding-agent@0.84.2`                       | 分别辨认 root 与 Runner 安装，实际加载公开 SDK      |
| 已安装 Durable          | `@earendil-works/pi-durable@1.3.0`                             | 产品接入目标；不能用 Coding Session 代替            |
| pi-messenger            | `0.15.2` / `09937ed647a1b07a3b595bf75943feacb80ff123`          | 优先验证真实双 Session 通信                         |
| pi-collaborating-agents | `0.4.6` / `acd50d0ec091deb03bb90b57b694131cff0c297d`           | 对照定向 send、replyTo、普通/urgent 投递            |
| 已安装 pi-subagents     | `0.16.1` / 对应 tag `bb4776388b017893ba1c74eb9593d9c495c62fcd` | 核查现有扩展注册；不升级、不用临时子 Agent 冒充 Dot |

三个插件的 package.json 均声明 MIT。pi-messenger 当前固定提交未提供独立
LICENSE 文件，因此这里只记录包声明，不声称校验过独立许可证正文。
精确 pin 另见 `scripts/member-inbox-compatibility/upstream-pins.json`。
运行脚本记录 root / Runner 两份安装锁文件的 SHA-256，并核对实验前后不变。

## 如何复现

使用项目要求的 Node，先完成现有依赖安装。脚本不安装插件或依赖，不修改生产配置。
在仓库之外准备两份只读候选源码，目录分别为 `pi-messenger`、
`pi-collaborating-agents`，checkout 上表固定 commit。`--sources` 指向其父目录。

```sh
node scripts/member-inbox-compatibility/load.mjs \
  --sources /absolute/pinned-sources \
  --package collaborating \
  --output /absolute/fresh-private-evidence/load-collaborating

node scripts/member-inbox-compatibility/run.mjs \
  --sources /absolute/pinned-sources \
  --receiver-state idle \
  --output /absolute/fresh-private-evidence/messenger-idle
```

`load.mjs --package` 支持 `messenger`、`collaborating`、
`subagents_installed`，仅验证实际 SDK ResourceLoader 的工厂加载/注册。
不创建原生 Session，不调用模型，不验证插件的其他功能。

`run.mjs` 默认选 Runner 安装的 SDK；`--sdk-scope root` 可显式对照 root 安装。
`--receiver-state` 支持 `idle`、`model`、`tool`。
`--plugin collaborating --delivery normal|urgent` 用于对照另一个固定插件。
messenger 没有同等的 urgent 工具参数，脚本拒绝对它指定 urgent。
`--scenario late-after-abort` 专门观察原生 abort 后插件收到迟到消息的行为，
用于识别产品取消栅栏的需求，不能作为产品 Stop 通过证明。

每次必须使用空证据目录，失败结果不会被后一次覆盖。准备阶段每个 Session
最多 240 秒，问答阶段 60 秒，总模型调用最多 10 次。无无限自动重试。
证据保存在本地，包括真实原生事件、Session / toolCall ID、因果消息 ID、
受控 provider 收到的输入、退出码、锁文件摘要，以及本次脚本源码快照。
应串行执行这些实验，避免与完整进程故障回归争抢启动与磁盘资源。

## 隔离方法及证明限度

每个 Agent 是独立 Node 进程，拥有独立临时 HOME / agentDir。
共享的 cwd、registry、消息目录只属于本次实验。环境不继承供应商密钥；
模型是绑定 loopback 的受控 OpenAI SSE fixture。
ResourceLoader 关闭 Context files、Skills、Prompt templates 和 Themes，
仅加载一个显式候选扩展。可执行工具只选择通信工具，不开放插件的子 Agent 工具。

脚本预先放置其他命名空间的随机 transcript canary，并检查模型输入不含 canary。
FS guard 会在常用 Node 文件访问 API 触及开发者 `.pi` / `.claude` / `.codex`、
项目 data 或实验外 transcript 时终止实验。它是诊断辅助，**不是安全沙箱**；
不能替代生产 ACL、进程隔离、Workspace policy 或插件治理。
生产接入不得靠该 guard 保护用户数据。

## 已观测结果

| 实验                                         | 结果                 | 可以证明什么                                                 |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| root SDK + messenger，接收者 idle，原型脚本  | 通过，5 次受控调用   | 两个真实 Coding Session 的消息/回复/原上下文续接             |
| Runner SDK + messenger，接收者 idle          | 通过，5 次受控调用   | 使用 Runner 实际安装，加载/注册未调用模型，双方正常退出      |
| Runner SDK + messenger，接收者 model running | 通过，6 次受控调用   | B 正在请求模型时接纳原生队列，在后续边界处理新问题           |
| Runner SDK + collaborating 工厂加载          | 通过                 | 扩展工厂及工具/事件注册可用；尚非原生投递通过                |
| Runner SDK + messenger，tool running         | 通过，6 次受控调用   | B 的真实工具尚未结束时入队，释放工具后读取并回复             |
| collaborating 普通投递，model running        | 通过，6 次受控调用   | 双向实际投递均为 followUp，原 prompt 完成前读取回复          |
| collaborating urgent 投递，model running     | 通过，6 次受控调用   | 双向实际投递均为 steer；仍在原生安全边界处理                 |
| 等待产品审批                                 | Pending              | Coding 实验不含 Product Runtime 的审批状态机                 |
| abort 后迟到消息                             | 已观察，5 次受控调用 | abort 返回后迟到消息启动新一轮；这是产品 Stop 所需栅栏的反例 |
| 当前 pi-subagents 工厂加载                   | 通过，0 次模型调用   | 仅扩展工厂/工具/事件注册；不代表实际子 Agent 执行通过        |

成功问答中，A 在本次运行生成随机 nonce 与算式，调用真实通信工具发给 B。
B 的 provider 必须从 **B 实际收到的原生输入**提取算式，回复引用实际收到的
消息 ID。A 的在途模型请求由 fixture 暂停，直到 SDK 的公开投递方法返回，
再推进到下一个原生边界；最终检查 A 的实际模型输入包含 B 的回答，且早于
A 初始 `prompt()` 完成。传输 ACK 不用作“模型已读”证据。

fixture provider 从收件方原生 details 观察到真实消息 ID，填入工具的 replyTo；
这不证明真实模型能从插件当前显示文本得知完整 ID。算式仍只从 B 实际模型输入解析。
脱敏原生关联与调用摘要见 [验收记录](verification/member-inbox-77/2026-10-25.json)。
完整原生输入和脚本快照留在本地私有证据目录。

model / tool 场景还要求 B 初始工作尚未完成时完成接收。工具场景只在真实扩展
工具的 execute 外加可控挂起点，随后执行原函数；不伪造通信工具结果。
这些证明针对 Coding Session；没有 Pi Durable Submission / Task ID 就不声称
恢复了某个 Durable Task。

## 保留的实验准备失败

- 第一版原型用 CJS require.resolve 查找 ESM-only SDK 导出，在加载前失败；改用包声明的公开 import 入口。
- subagents 首次加载被 FS guard 拒绝：受控工作树 node_modules 的符号链接路径位于 `.codex`，尚未进入插件代码。修正为先解析显式选定包的真实路径后通过，未扩大 guard 允许范围。

这两次属于 harness-invalid，失败记录保留，不归为插件不兼容，也不覆盖后一次成功记录。

## API 与持久性发现

- messenger 的实际投递为 `sendMessage(..., {triggerTurn:true, deliverAs:'steer'})`。
  工具 send 返回收件人，但未返回本次生成的完整邮件 ID；收件方原生消息 details
  才含有该 ID。产品 adapter 需要明确的结构化因果回执，不能让模型猜 ID。
- collaborating 的 `urgent:false` 使用 `followUp`，`urgent:true` 使用 `steer`。
  这描述原生边界选择，不保证任意 token 中断，更不能撤销已执行工具副作用。
- `session.pendingMessageCount` 不统计本次 custom message 的全部原生队列状态。
  不能用值为 0 推断未投递；实验观察实际公开投递方法、原生状态和 provider 输入。
- 两个插件都有本地文件 registry / inbox、文件 watcher 和进程/Session 信息依赖。
  collaborating 还提供 sessions/tail、子 Agent 和 reservation 能力。
  这些不是现有 Group ACL、跨用户隔离或 Cloud transport 的实现。
- 在原生 abort 已返回、A 初始 prompt 已结束后，messenger 的迟到回复触发了新的 A 模型请求。
  该实验验证原生行为，不是产品 Stop 通过；新轮不能称为原任务恢复。
- fs.watch 收件加原生 enqueue 不等于 Product Runtime 的持久 admission、消费回执、
  cancellation epoch、live grant 校验或至少一次对账。已有演示不覆盖 lost ACK / 重启。

源码依据：
[messenger 固定源码](https://github.com/nicobailon/pi-messenger/tree/09937ed647a1b07a3b595bf75943feacb80ff123)、
[collaborating 固定入口](https://github.com/baochunli/pi-collaborating-agents/blob/acd50d0ec091deb03bb90b57b694131cff0c297d/extensions/collaborating-agents/index.ts)。

## 产品接入决策

保留定向 send / replyTo / 边界接收的通信模式，**不把两个本地插件安装到产品群聊或
Workers**。Group × Dot 继续使用已有 Product / Pi Durable Session，版本保持不变。
Phase 0 确定的 Product Runtime / GroupDiscussionService 接入边界如下；
后续实现状态及证据以 [Node 记录](member-inbox-node-77.md) 为准：

1. 从真实执行上下文推导 sender、owner、Group、原生输入和 Task；两端检查 live ACL。
2. 明确区分持久 admission、提交原生 Inbox、实际消费、因果回复和最终发布。
   submit 结果不明时对账原 request/input，不能换 ID 重试。
3. 冻结输入不可变，新请求/回复/用户纠正必须有新 ID、digest、可见消息 frontier 和预算关联。
4. 新通信契约独立版本、默认关闭；老 coordinator/relay 的 queue-only 校验保留。
   同一 Session 仍只有一个 owner，首版仅两个成员；send 不持群锁等待对方。
5. Stop/撤权先持久化 fence，再原生 abort；迟到回复不得唤起停止的 Run。
   等待消息与等待审批不伪装为 completed，也不能自行授予工具、Memory、Device 权限。

Node Durable 的公开 `Conversation.submit` / `whenBusy` 与 Coding ExtensionAPI 是
不同接口。后续双向成员消息、恢复、Stop、审批与用户纠正的实际 Product Runtime
证据已在 [Node 记录](member-inbox-node-77.md) 单独维护，不能用此处插件实验替代。
Cloud/local workerd、部署 staging、真实模型、Chrome 和物理手机单列验收，均不由此表代替。

完整 Node/Web/authority 回归仍是门禁；专项实验通过不能覆盖全量失败或远程 CI 失败。

## 后续切片：Node 原生来源绑定

`PiDurableRuntimeAdapter.productToolSource` 从真实 Tool Task 的已提交 ancestry，
以及公开 LiveDoc 的当前 generation / placed Submission 记录，返回本次已消费的
request、submission、entry 与 Task ID。排队但尚未放入原生上下文的输入不在结果内。
只接受已激活 adapter 的 running Tool Task；读取前后检查原生 ancestry 与鉴权。
返回值仅供服务端关联 Product 收据，不能替代 Group ACL 或作为客户端授权凭证。

实际 Node Durable + SQLite + faux provider 验证了两种边界：

- `followUp` 在第一条输入完成后开始下一条输入；两条输入有不同的最终 answer entry。
- `steer` 在工具仍运行时仅排队，工具轮次结束后才进入上下文。下个工具关联的
  placed inputs 同时含原请求和新纠正，原请求尚未结束，两条输入最终关联同一答案。
  原生 generation Task 已切换，不能称为恢复了同一个 generation Task。

测试从下个真实 provider 输入检查「Only handle the preview environment.」已存在；
这证明了上下文边界，不代表部署或文件写操作已按该约束验收。
两种情况还验证其他 conversation、非 Tool Task、终态 Task、未激活 adapter 和
撤销鉴权后的读取被拒绝；模型调用分别为 4 和 3 次。这里的鉴权是 fixture 提供的
adapter 回调，真实群成员/模型 grants 的组合还需后续 Product Runtime 集成验证。

复现：

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
  tests/pi-durable-tool-source.test.ts \
  tests/pi-durable-runtime.test.ts \
  tests/pi-durable-input-ledger.test.ts
```

该组合 3 文件 / 15 项通过；加上共享群聊设置检查为 4 文件 / 20 项。Node personal-agent、
Web 和 E2E 类型检查均通过。在该来源绑定基础阶段，尚未实现成员 Inbox 的持久
投递和双成员 Product 闭环，不能把该阶段算成 #77 完整交付。后续实现与原生证据见
[Node 成员问答](member-inbox-node-77.md)；本段保留早期基础阶段的证明范围。
