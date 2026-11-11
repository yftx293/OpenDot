# Node 成员问答补充边界验收（2026-10-25）

实际生产 HTTP / Product / Pi Durable / SQLite；模型为隔离的 loopback 可控响应。
本目录 13 份记录来自同一次冻结源文件后的回归：10 个文件、53 项通过（234.02 秒）。
包含重复覆盖，不与此前用例数相加。每份记录保存关键源文件 SHA-256。

| 场景                                                                                  | 预期终态     | 实际模型调用 |
| ------------------------------------------------------------------------------------- | ------------ | ------------ |
| [approval-control-replaces-consent](approval-control-replaces-consent.json)           | completed    | 7            |
| [bounded-cycle-with-control](bounded-cycle-with-control.json)                         | failed       | 10           |
| [expired-original-question](expired-original-question.json)                           | failed       | 3            |
| [final-before-peer-consumption](final-before-peer-consumption.json)                   | completed    | 4            |
| [live-removal-and-default-off](live-removal-and-default-off.json)                     | failed       | 2            |
| [lost-ack](lost-ack.json)                                                             | completed    | 1            |
| [model-budget-fenced](model-budget-fenced.json)                                       | waiting_user | 1            |
| [peer-reply-during-approval](peer-reply-during-approval.json)                         | completed    | 4            |
| [private-native-context-isolation](private-native-context-isolation.json)             | completed    | 5            |
| [restart-original-inputs](restart-original-inputs.json)                               | completed    | 6            |
| [restart-stop-gray-off](restart-stop-gray-off.json)                                   | cancelled    | 1            |
| [unfinished-sender-reply-and-correction](unfinished-sender-reply-and-correction.json) | completed    | 4            |
| [upstream-errors-charged](upstream-errors-charged.json)                               | failed       | 4            |

覆盖旧 root 最终回答的暂存、实际 peer 消费、私人原生上下文隔离、审批等待与用户纠正、
预算耗尽、上游错误重试计量、原问题过期、四跳循环、丢失 ACK、重启与 Stop。
`waiting_user` / `failed` / `cancelled` 是相应负向场景要求的结果。

该记录不代表供应商实聊、Cloud、跨用户权限或全量 CI 通过。
随后 Chrome 发现“已有群聊追加工具授权”会报 `GROUP_DISCUSSION_SESSION_IDENTITY_CHANGED`，仍待修复。
[实现与限制](../../../member-inbox-node-77.md)。
