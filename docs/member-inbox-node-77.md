# #77：Node 成员问答与本地证据

本页记录 #77 的双成员 Node 实现与分阶段证据。后续 #78 已另行实现默认关闭的
有界并发、Cloud 成员适配、单成员 Stop，以及四种组合的部分生命周期验证，见
[Cloud 成员通信与当前验收范围](member-cloud-78.md)。这些增量不扩大本页较早记录的证明范围。
#77 与 #78 的完整验收仍未结束。冻结提交 `4ef4738` 的完整本地 Root 已通过
3361 项、保留 23 项既有跳过；Authority 120 项、workerd 86 项及 8+1+1 项浏览器
检查均通过，见[源版本固定的完整门禁](verification/member-cloud-78/scope-delivery-recovery-2026-10-26/complete-gates-4ef.json)。
后续双账户隔离专项与 Web 菜单修复分别保留自己的源码和复测结果，不扩大这次完整 Root 的范围。
后续 [18 项浏览器复测](verification/chat-shell-75-2026-10-26/README.md)已通过，
默认群聊入口另复跑八项通过，包含审批、Stop、撤权、退出登录及群聊/单聊的后退前进。
main 目前仅手动 CI，当前提交没有 exact-head 远程 CI 通过证明；较早父分支失败
保留在原阶段记录中。最新 Chrome 真实 WorkBuddy 首次单聊遇到 429，三轮实聊仍未通过；
[受控错误反馈复测](screenshots/chat-error-feedback-75-2026-10-26/README.md)与供应商验收分开记录。

## 产品入口

服务端显式设置 `MINICLAW_GROUP_MEMBER_INBOX=true` 后，群聊高级讨论设置显示
“边工作边互相提问（实验）”。选择两位本机 Dot，启用并保存；设置只影响新讨论。
普通建群、选择 Dot 和启用讨论仍走现有 API，测试没有预写执行 grant 绕过入口。
基础问答不授予文件、Shell、部署、Device 或私人 Memory 权限。

新模式使用独立 `execution_contract=member-inbox-v1`，不改变已有
`coordinator-v1` / `relay-v1` 的策略枚举、queue-only 校验、冻结输入或 pending-turn 索引。
缺省契约是 `serial-v1`；旧设置的响应形状和幂等命令 digest 保留。

## 原生边界与来源

- 每个 Group × Dot 复用自己的 Product/Pi Session。现有
  `GroupDiscussionService` 只推进产品关联，Pi Durable 保持唯一执行 owner。
- `ask_group_dot` 从实际 ToolAPI Task、其 Generation 祖先及已经 placed 的
  Submission 推导发送者和来源。模型仅选择接收者和公开问题内容；不能自行指定 owner、
  来源 Task、Run、原生 input 或权限。
- 工具返回持久接收回执，不等待对端答案，也不声称对端已读。
  接收者通过自己的原生输入运行；发送与消费时都重验成员、scope、grant、配置和取消栅栏。
- 问题、已提交原生输入、实际消费、原生最终回答和返回投递分别记录。
  回答由 Product 原生结果台账关联 `in_reply_to`，不依赖模型猜测消息 ID。
- 新输入使用原生 `steer` 安全边界。新模式批量接收该边界前的所有 steer，
  防止一条旧 peer 回复把较新的用户限制留到下一次生成之后。旧模式仍使用原设置。
- `read_group_context` 只读取当前原生生成已经消费的冻结上下文，不能轮询未来邮件或私人历史。
  续接可以产生新 Generation Task；同一工作关联不等于恢复了原 Task。
- 每次实际模型 dispatch 校验原生 Generation、attempt、已消费 input 和规范化上下文
  digest，再原子计入成员和 Run 预算。打开页面、读取快照、空闲成员不调用模型。

真实提问、回答和最终结果进入现有 canonical timeline。没有增加工具过程发言、
正文 token 流式展示或新的进度仪表盘。原生同一 answer entry 合并多个输入时，最终结果只发布一次。

## 持久化、预算与停止

Schema 加性升级至 v89，沿用升级前私有备份和拒绝降级机制。新增台账保存成员租约、
冻结投递、原生消费来源、最终发布去重和模型请求关联，不保存第二份群历史。
既有 frozen payload、request、policy 和 protocol_version 不被迁移改写。

当前边界：两位 Node 成员；每 Run 最多 64 个冻结输入、32 条通信、64 KiB 通信正文；
每成员最多 16 条未决投递。问题最多 4 KiB，最终回答最多 16 KiB，冻结上下文最多 32 KiB。
通信链最多 4 跳，期限不超过首次问题的两分钟；续问和用户纠正不重置跳数或期限。
模型和公开消息继续受已有成员 grant、Run 总额及每 Dot 发言额度限制。
关联修复最多三次，以原 request/input reconcile，不创建替代请求。

Stop 先提交递增取消 epoch、撤销待执行审批、取消未决输入和成员投递，再调用原生 abort。
原生完成前保留 stopping/uncertain。若在栅栏提交后重启，恢复专门的无 Provider、
无工具执行能力 owner 完成原生取消；核对原生任务终态后才释放停止标记。
迟到结果不能再发布或唤醒旧 Run。关闭 feature flag 阻止新准入，但既有任务仍能恢复和停止。
用户追加约束也使旧待批效果失效；已执行的外部效果不会被宣称回滚。

## 已执行的本地验证

运行时为实际生产 HTTP / Product Runtime / Node SQLite / Pi Durable 1.3.0；
模型响应来自隔离的 loopback 可控 provider。以下不代表真实供应商或 Cloud 执行通过。

| 场景                                                 | 可核对结果                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A 未完成时提问、B 回答、用户插话、A 续接             | 4 次模型请求；4 个冻结输入；问题和回复各一条；后续原生生成同时消费回复、预览限制和原 root，最终结果一条                 |
| submit 已完成但 ACK 丢失；同一用户命令重复提交       | 1 次模型请求；2 次原身份关联尝试；同一 Product input 和 Submission；结果一条                                            |
| 两个原生模型请求期间 SIGKILL、重启                   | 原 request/input/Submission 保持不变；重试计量后共 6 次模型请求；问题、回复和最终结果不重复                             |
| Stop 栅栏后、native abort 前 SIGKILL，关闭开关再重启 | 只有原来的 1 次模型请求；原生输入 unanswered、全部原生任务 terminal；停止标记只在核对后清除；重放 Stop 不重置 epoch     |
| 默认关闭、跨群目标、实际运行中移除成员               | 默认不准入；跨群 Dot 不被唤醒，其他群 canary 未进入模型；撤权后旧 Run 明确失败并停止，迟到答案不发布                    |
| v88 → v89                                            | 私有备份保留旧 schema 和冻结字节；旧 Run 仍为 serial/原 policy/原 protocol；新台账为空；身份和 epoch 约束有效；拒绝降级 |

原生来源与冻结输入证据位于
[`verification/member-inbox-77/node-2026-10-25/`](verification/member-inbox-77/node-2026-10-25/README.md)。
负向撤权场景的 Run 状态为 `failed`，Stop 场景为 `cancelled`，均为测试要求的结果。

本次专项记录：10 个文件 45 项回归通过；旧群聊/后台工作/迁移 3 个文件 15 项通过；
最终成员问答与 v89 迁移 2 个文件 6 项通过。包含重复覆盖，不能相加作为独立用例数。
Node 与个人 Agent TypeScript、Web 和 E2E 类型检查通过；最终 Web 构建通过（2 分 14 秒）。后续边界回归 10 个文件 53 项通过（234.02 秒），个人 Agent、Web、E2E 类型检查与设置修复后的 Web 构建也通过。

补充证据见 [13 份原生边界记录](verification/member-inbox-77/node-controls-2026-10-25/README.md) 和 [实际 Chrome 截图](screenshots/member-inbox-77-2026-10-25/README.md)。Chrome 已验证多选建群、默认关闭、互聊、刷新不重复调用与 Stop；设置滚动后关闭出口已修复，新增自动浏览器用例通过。完整创建/导航套件为 7/8 通过：单聊项缺少测试工作树的 agent-runner 编译产物，后续讨论套件未运行。不能把这批浏览器验证称为全部通过。

早期失败保留在本地原始日志：第一次编译暴露了共享 payload 的类型不匹配；
第二次因验收 SQL 表名写错而失败；第三次在实际边界验证中发现原生默认
`one-at-a-time` 未同时消费较新的用户限制。修正为新模式专用 `all` 后重跑通过，
并把模型回调中的验收异常转交给主测试，避免未处理异常被误读为成功。
这些失败没有通过增加既有超时或绕过权限来消除。

复现：

```sh
MINICLAW_MEMBER_PROOF_DIR=/absolute/private/evidence \
  node node_modules/vitest/vitest.mjs run \
  tests/group-member-inbox-http.test.ts tests/schema-v89-member-inbox.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.personal-agent.json --noEmit
```

证据目录选项仅用于隔离的 synthetic fixture，不读取或导出本机真实对话与凭据。

## 仍需完成

审批等待与纠正、过期/循环/预算耗尽/上游错误、私人原生 Session canary 的专项现已通过。

Chrome 发现的旧会话追加授权问题已修复，并有[同一 Session 的授权演进证据](verification/member-inbox-77/node-permissions-2026-10-25/README.md)：
创建时的 origin 继续固定工作区、运行时、模型配置；新成员 Run 的工具能力从该 Run 不可变的 grant 租约获取。
缓存 owner 在新租约下重新选择工具，工具定义已注册不等于执行权限；每个实际工具执行还核对原生输入来源和同一租约，旧 Task 不能借用新 Run 的授权。
运行中换发授权仍使旧 Run 停止、旧审批失效；旧 serial/coordinator/relay 的身份和 frozen 校验保持原样。
三个原生专项通过，新增手机浏览器授权→查看请求→批准→已有群聊续聊用例通过（17.3 秒）；
合并后的 15 个文件 72 项原生回归全部通过（495.30 秒），包含旧讨论/后台工作/迁移/私聊恢复；
原有六项讨论浏览器用例也全部通过。之前那个 Chrome 群聊已用同一 Session/Conversation 完成审批和续聊，4 次调用，刷新没有重复请求，
[截图与原生关联](screenshots/member-inbox-77-2026-10-25/README.md)已补齐。
跨用户原生隔离已有[独立双账户验证](verification/member-inbox-77/cross-user-2026-10-26/README.md)：
四次越权读写分别返回 404/403，其他账户私聊原生输入未变，本群问答正常完成。
更多 source 拒绝/乱序仍需逐项核对。设备离线已补充
[同群 Goal 等待与成员准入隔离](verification/member-inbox-77/device-boundary-2026-10-26/README.md)：
原工作任务等待并恢复原 Device Tool Task，成员讨论被明确拒绝且不分配新输入或 Session。
当前成员工具不直接支持 Device 执行，不能将该结果标成成员 Device 工具运行成功。
Node 新成员模式已完成
[授权模型三轮 API 验收](verification/member-concurrency-78/real-node-2026-10-25/README.md)，
包含实际问答、更正、同一 Session 续聊与重启；后续修复后的完整旧模式 API 对照
见[三轮对照记录](verification/member-concurrency-78/serial-correction-2026-10-25/README.md)。
当前 Chrome 版本的真实模型三轮仍未通过，不能由这些较早 API 记录替代。
新权限审批浏览器流程已通过。
后续有界 Node/Cloud 配额与恢复、Stop、成员撤权、过期和用户更正已有独立实现与证据：
[成员 Run](verification/member-cloud-78/runtime-2026-10-25/README.md)、
[单成员 Stop](verification/member-cloud-78/stop-2026-10-25/README.md)、
[生命周期](verification/member-cloud-78/lifecycle-2026-10-25/README.md)。
它们仍不是 #78 的全部负向矩阵、自然真实模型或 staging 验收；默认开关继续关闭。
完整构建与 434 文件 Root 回归已在后续切片通过，见
[完整门禁记录](verification/runtime-gates-2026-10-25.md)；exact-head CI 仍未通过。
本页较早的局部绿、旧失败记录与后续专项都不能代替完整发布验收。
