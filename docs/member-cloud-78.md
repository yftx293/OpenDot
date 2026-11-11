# Cloud 成员通信与恢复（#78，开发中）

本分支在基础层之上追加了按 Run 授权的 Cloud 成员适配。新模式默认关闭，
须同时显式开启 `MINICLAW_GROUP_MEMBER_INBOX`、`MINICLAW_GROUP_MEMBER_CONCURRENCY`
和 `MINICLAW_GROUP_MEMBER_CLOUD`。缺少 Cloud 开关时，新的混合成员讨论仍会拒绝准入。
现有 Cloud Group、Handoff 和 Goal 不会因为注册新工具定义而获得新权限。

加性迁移保留既有输入、来源和预算，并在升级前备份、拒绝降级。Cloud 准入标记
按 Run 冻结；关闭开关只阻止新模式准入，既有已授权运行仍可对账和停止。
这仍是开发中的实验能力，不能据此关闭 #78 的全部发布验收项。

## 按 Run 的 Cloud 成员执行

仍由原有 ProductRuntimeService、PiHarness Root、签名 RPC、输入回执和恢复 Alarm
推进工作，不创建另一套原生 Task、Scheduler 或本机替代执行。每轮元数据绑定
Group、Dot、Session、runtime、grant、lease、取消 epoch 和期限；同一个持久 Session
只有在旧原生执行已静止后才可接收下一轮。旧输入和旧 Stop 不能重新占有它。

模型调用提交真实原生生成 Task、attempt、已放入本次生成的输入 IDs 和上下文摘要。
Node Authority 仍从原有加密配置读取 Provider 凭据，并与 Node 成员共用群、owner、
成员容量及 token 账本。控制调用和 peer 回答同样计量；不会将 Provider key 放进 DO。
DO 每次实际打开原生 owner 的持久 revision 用于拒绝迟到的旧调用；原 owner 已调度
但没有可靠用量的请求保留不确定支出，传输请求与预算记录以独立的不可变关联对账。

Cloud 模型中断使用带原始成员 lease 的恢复 subject，复用原 Alarm 和重试上限。
恢复不伪造新输入或宣称 Cloud 可绕过离线 Authority。Group Stop 先在 Node 提交栅栏，
随后原生 abort；新一轮在安装自己的授权后才检查执行状态，避免被上一轮暂停挡住。

工具只选择本轮明确授予的 `inspect_text`、`create_approved_artifact` 与成员问答工具。
产物审批意图还绑定实际原生工具来源，准备和执行时核对已消费的最新用户指令。
撤销后的旧审批回执允许原任务读取并退出，以便抵达排队中的新指令边界；
未知传输失败继续保留不确定状态，不能据此执行或盲目重建审批。

成员禁用后的旧审批/迟到请求、原问题过期和工作中用户更正，已经补齐四种组合的
[生命周期专项](verification/member-cloud-78/lifecycle-2026-10-25/README.md)。
跨群 canary 与带用户更正的四跳循环已补齐四种组合，见
[跨群隔离与有界循环](verification/member-cloud-78/boundary-2026-10-25/README.md)。
明确模型请求/认证拒绝及报告用量超额，已补齐四种组合的
[模型故障专项](verification/member-cloud-78/model-errors-2026-10-25/README.md)。
单次 503/429 恢复，以及产物落盘后未确认时 Authority 退出恢复，已补齐四种组合，
见 [恢复专项](verification/member-cloud-78/resilience-2026-10-25/README.md)。
模型禁用与 Host 工作区执行合约撤回已经补齐四种组合，见
[模型与 Host 合约撤权](verification/member-cloud-78/policy-2026-10-25/README.md)。
独立成员/Run 预算、资源冲突，以及关闭准入后的 reconcile/stop 共二十项完整
原生用例也已完成，见
[预算、资源与灰度记录](verification/member-cloud-78/conflict-budget-rollout-2026-10-25/README.md)。
单成员 Stop 的范围、迟到回复与旧命令重放证据见下节。
Workspace 改绑、成员提问/回复 ACK 丢失及实际 Authority 离线恢复，新增了
[18 项原生专项与两处修复](verification/member-cloud-78/scope-delivery-recovery-2026-10-26/README.md)。
这些记录仅证明列出的权限与恢复边界；
本机 Node 成员已完成授权模型三轮 API 验收，见
[真实 Node 三轮记录](verification/member-concurrency-78/real-node-2026-10-25/README.md)。
旧 relay 首轮的过期答案失败记录保留；随后修复并完成两个模式各三轮的
[真实 Node 对照](verification/member-concurrency-78/serial-correction-2026-10-25/README.md)，
共 20 次真实请求，模拟请求 0。Cloudflare staging、当前 Chrome/真机和其余发布
验收仍未完成。
下面较早的基础层记录不能替代这些验收。

实际产品入口的四种组合、停止后复用、重启、审批和用户更正记录见
[成员 Run 验证记录](verification/member-cloud-78/runtime-2026-10-25/README.md)。
13 项场景已经通过，调用和预算记录逐项保留；模型均为隔离的可控 fixture。

## 单独停止一位 Dot

有界成员 Run 的群聊详情现在提供每位 Dot 的停止入口。该动作冻结确切成员 lease，
随后确认原生 abort，不增加整轮的取消 epoch。相关问题被取消时，只将带原始问题
关联的控制输入送给实际依赖者；闲置旁观者不会因此推理，也不会伪造同伴答案。
单独的后台工作仍使用原有停止控制。原生确认丢失时保留 uncertain，允许原范围重试。

这一步使用 v92 加性迁移保存不可变停止来源，升级前备份；旧 Run、预算和输入不清空。
回滚应关闭新模式准入并对账现有任务，不能将 v92 数据库交给旧二进制强行降级。
Node/Cloud 四种组合、停止问题发送方或接收方、下一轮复用、空闲 Cloud 成员、
原生 Stop ACK 丢失并重启，以及 Chrome 手机布局的记录见
[单成员停止验收](verification/member-cloud-78/stop-2026-10-25/README.md)。
这些原生测试使用可控 provider，不等于真实模型自然任务、生产 Cloudflare 或真机验收。

## 已实现的边界

Node 和 workerd 共用不含包依赖的来源算法。每个执行主机用自己安装的 SDK
提供 Task、Submission、LiveDoc 读取器及版本标识；算法不开启第二个 Harness，
不读取私聊、文件或 Provider 凭据，也不从显示层重建模型上下文。

返回信息只包含实际原生 conversation、生成/工具 Task、已放入该生成的
Submission、request、entry IDs；模型生成阶段额外返回实际 attempt。
排队中的 followUp/steer 不算已读。工具执行时其 generation 可能正在等待工具，
LiveDoc 也可能不再保留模型 attempt；工具来源不伪造一个 attempt 来填补空缺。
读取结束前再次核对 live ACL、原生 owner、输入集合和活跃状态。

`ask_group_dot` 和 `read_group_context` 定义复用既有签名 `/tools` 通道。
提问先获取 Authority 准备的绑定，再通过原生 `ToolExecutionApi.memo` 持久化，
然后提交同一绑定；提交返回 admission，不能声称对方已读或已回复。
Node Authority 根据签名 Session scope、当前成员 lease、Group origin 和冻结输入
重新核对来源、权限、取消状态及内容。公共上下文响应只能对应当前原生输入 IDs。

注册定义与选择工具分开。旧 Cloud `Agent.tools` 仍只选择旧 binding 授权的工具；
新成员模式才按冻结的 Run 契约配置原有 Root。新定义不会自动进入旧 Run。
Cloud 工具消息的 Node/Worker Zod 校验器分别在各自
工作区解析依赖，配合协议一致性测试，避免要求独立 Cloud 安装具有根目录依赖。

## 用户更正的公共提问栅栏

新增用例复现：三个成员正在执行或排队时，用户取消部署要求，旧模型调用仍可向
同伴发送两条过时问题。现在公共提问在准备和提交时均要求实际原生输入已经包含
最新用户指令；旧调用不会因为获取了新 epoch 就被当作读过更正。
测试继续核对原始 payload 不变、无过时邮件、最终回复唯一及模型调用次数。

## 问题回复与用户更正的因果边界

有界成员模式下，接收方已经生成旧答案，但用户更正仍在原生队列中时，旧答案不能
先发布给提问方。原问题保持待答，直到最新更正获得真实的原生完成回执。
若新答案属于另一个 Task，冻结的更正输入还必须包含完整、未截断的原问题；
无法证明该读取时继续等待原期限，不猜测问题归属，也不延长期限。

回传仍使用原问题的 `in_reply_to` 和 deadline，但来源明确指向产生更正答案的
真实 Product input、Submission、Task 和 answer entry。旧输入、旧原生答案及
payload digest 均保留。共同消费同一原生答案的输入复用同一回执，公共回复只发布一次。
旧的串行策略和未启用有界模式的成员讨论保持既有契约。

Cloud 的成员模型请求在 lease 结束后仍按原有版本化封套识别，进入真实执行权限
检查；不会因活动 lease 已释放而被误当作普通模型请求。旧请求重签后依然拒绝，
既不唤醒新 Run，也不新增模型调用或预算记录。

## 验证范围

Node Adapter 与真实 workerd SQLite 的原生能力测试分别覆盖 followUp/steer、
工具运行中投递、正确来源关系、旧任务失效、错误 scope 和撤权。
workerd 工具测试使用真实原生 Tool Task、memo 与签名请求，但 Authority 是可控
fixture；这类测试不代表产品建群或跨 Runtime 讨论已经通过。

已复现只安装 Cloud 工作区依赖时，根目录 SDK/Zod import 导致 Wrangler 构建失败。
修正后通过无根目录 `node_modules` 的独立类型检查和 dry-run。可复跑：

```bash
node scripts/check-cloud-standalone.mjs
```

该脚本只复制指定源码/配置到临时目录，只链接 Cloud 工作区的已安装依赖，
运行类型检查及 Wrangler dry-run，最后删除自己的临时目录。它不部署、不读取
`.env` 或 `.dev.vars`，也不更改现有依赖目录。

本轮专项回归：Node 11 个文件、46 项断言通过；workerd 全部 5 个文件、67 项断言通过。
之后删除一个未使用的类型 import，原生来源与协议一致性 3 项检查再次通过；
编译 JavaScript 与 46 项回归时一致。来源接口的格式整理只改变类型声明空白。
完整 `make typecheck`、Cloud 独立类型检查和 Wrangler dry-run 通过。

初始 workerd 回归有 5 次 `CLOUD_EXECUTION_SUSPENDED` uncaught 启动拒绝，
以及故意破坏 checkpoint 的负向拒绝；原始失败记录保留。后续已针对启动
恢复与空闲会话分别复现并修复，见下面的启动恢复记录。专项断言通过仍不代表
跨 Runtime 产品验收完成。

原生来源/签名工具证据和用户更正回归见
[基础层验证记录](verification/member-cloud-78/foundation-2026-10-25/README.md)。
最终类型/格式整理后 Node 3 项、workerd 6 项再次通过；现有 Cloud 产品 HTTP、
Handoff 的 3 文件 7 项回归通过，包含重启、丢失 ACK、撤权与停止。

## 启动恢复与测试门禁

已有 managed Goal/Handoff 在原生输入已持久化、但执行 owner 尚未重新打开时，
Authority 暂时拒绝会令 Lifecycle 返回通用 500。现在仅对已识别的授权中断，
将原有恢复 subject 放入同一个持久恢复账本与 Alarm；保留原 Submission/Task、
尝试次数和期限。没有新的原生输入，没有将等待任务标为完成，也不转交本机执行。
损坏的 checkpoint 和错误 scope 继续拒绝。

已完成的空闲会话重连也不应开启执行 owner。现在复用现有存储静止性检查，
只有原生工作仍未结束或需要初始化 Root 才进入执行启动；实际读写和历史访问
仍单独检查 live Authority。撤权后的请求保留明确拒绝，不因空闲重连变成通用 500。

这两项测试使用真实 workerd SQLite、原生 Task、实际 Lifecycle fetch、对象重建
与 Alarm，模型和业务授权为 fixture。它们验证已有恢复机制，不等于已实现新的
Cloud Group 成员 Run 契约或混合群聊恢复。

`npm --prefix apps/cloud-agent test` 现在也检查真实 runner 的输出：断言通过但
存在 workerd uncaught/Unhandled 错误时仍返回失败。用初始 67 项通过却含启动错误
的日志复查，新门禁正确返回失败；预期的损坏输入拒绝仍保留测试与原始错误。

最终通过标准 `npm test` 门禁：workerd 5 文件 69 项通过，零 uncaught/Unhandled；
Node Authority 集成 8 文件 14 项通过。损坏输入的预期拒绝仍保留，未放宽旧断言。
Cloud 独立依赖类型检查与 Wrangler dry-run 也通过。原生恢复记录和当前来源 hash 见
[启动恢复证据](verification/member-cloud-78/foundation-2026-10-25/startup-recovery.json)。
这些是本地 Runtime 与 fixture 推理检查，不是生产 Cloudflare 或真实模型验收。

## 当前发布验收边界

- 后续冻结源码 `a296b7c4726da20754d6a48375d0b5b9d30ce291` 的完整 12 步本地队列
  已通过：workerd 5 文件/86 项、Authority 24 文件/134 项、Root 436 文件/3367 项
  通过及 23 项既有条件跳过，四组浏览器 8+8+1+1 项通过。类型、构建和每一步
  错误日志门禁均通过，前后 2064 个已跟踪文件实际字节一致。
  [本次完整记录与验收边界](verification/issues-75-78-2026-10-26/README.md)
  单独保存，不能将它改记为后续文档提交、真实 WorkBuddy 或生产部署通过。
- 模型禁用、Host 合约撤回、预算、资源冲突、单成员 Stop 与关闭准入后的对账/停止
  已有上面的四组合本地记录。Workspace ACL 的其余变化、更多工具 ACK 和 Authority
  离线边界仍须逐项核验；不能从单个恢复场景推定全部状态。
- Node 授权模型三轮及修复后的 relay/member 三轮 API 对照已有独立记录，旧失败保留。
  当前 Chrome 的新版本真实 WorkBuddy 首次单聊仍遇到四次 HTTP 429，未完成三轮；
  后续[受控错误反馈与同群刷新验证](screenshots/chat-error-feedback-75-2026-10-26/README.md)
  使用零次真实供应商推理，不能代替自然任务或混合部署实证。
- 生产 Cloudflare staging 与物理手机仍未完成；本地 workerd、Chrome 手机宽度、
  实际部署和真实输入法继续分开记录。新模式默认关闭。
- 冻结提交 `4ef473890b1135d1b231325017454201b749783e` 的完整 Root 为 435 文件、
  3361 项通过、23 项既有跳过；Authority 为 21 文件、120 项通过；workerd 为
  5 文件、86 项通过；浏览器为 8 项建群/导航、1 项并发、1 项单成员 Stop 通过。
  类型与构建门禁均通过，[完整命令、退出码与日志 hash](verification/member-cloud-78/scope-delivery-recovery-2026-10-26/complete-gates-4ef.json)
  与 [Authority 原始记录 hash 索引](verification/member-cloud-78/scope-delivery-recovery-2026-10-26/complete-authority-manifest-4ef.json)
  分别保存。后续双账户隔离用例及 Web 菜单/重连呈现的改动，另按各自源码验证，
  不将该完整队列改记为后续提交的全量 Root。
- 后续菜单、错误重试与浏览器历史修复已有 [18 项浏览器复测](verification/chat-shell-75-2026-10-26/README.md)
  及默认八项套件通过；真实 WorkBuddy 三轮仍保持上述未通过状态。
- main 已切为手动 CI；当前提交没有 exact-head 远程 CI 通过证明。本地通过不替代
  其余发布验收；较早父分支的 CI 失败记录继续保留。

Node→Node 的原有证据见 [Node 并发记录](member-concurrency-78.md)。
#75–#78 的完整目标仍在推进，默认开关保持关闭；尚未关闭发布验收项。
