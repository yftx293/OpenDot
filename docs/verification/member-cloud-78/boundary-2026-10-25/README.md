# #78：跨群隔离与有界循环通信

四种 Node/Cloud 组合分别验证跨群隔离和带用户更正的循环通信，共 8 项通过。
使用真实产品 HTTP 准入、Node Pi Durable、local workerd PiHarness、SQLite、
原生 Submission/Task 和工具回执；推理为可控 synthetic provider。
这不是 WorkBuddy、生产 Cloudflare 或物理手机验收，新模式仍默认关闭。

本目录八份原始记录对应 `5f1a578` 所在实现切片，后续模型故障修复改变了
其中一个被记录的代理源码 hash；没有改写这些历史记录的 hash。
应在该历史版本运行本目录完整性脚本。当前源码的模型故障记录见
[模型拒绝与超量用量](../model-errors-2026-10-25/README.md)。

## 跨群隔离

通过产品 API 创建两个 Dot，再将同一对 Dot 加入两个群。第二群先执行原生 Run，
接收并回答随机 canary；第一群随后进行 Developer → Reviewer 定向问答。
Reviewer 在 Developer 尚未结束时接收本次新问题，原生回答经 `in_reply_to`
返回，Developer 在新的原生安全边界使用答案完成。

每组共 5 次 provider 调用：第二群种子 1 次，目标群问答 4 次。目标群仅发布
一份回答与一份最终结果。模型输入和目标群时间线没有第二群 canary；第二群
原有 Run、输入、消息未变化，也没有额外唤醒。同一个 Dot 在两个群的 Session
不同。记录保留前后数据，不只保存布尔结论。

## 循环、用户插话与预算

两位 Dot 在原生工具边界相互提问，形成 1–4 跳的链。用户在两者仍执行时发送
“仅预览”更正。后续输入带入该约束，第五跳的实际工具结果为
`GROUP_MEMBER_HOP_LIMIT`。旧四条请求的 ID、跳数、期限和冻结输入不改变。

每组调用为 Developer 6 次、Reviewer 4 次；Run 最终为
`failed / GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED`。这是预期的有界失败，
不是任务成功。没有伪造最终群回答，成员 lease 均结束，准入无 active/waiting。
一个被停止的在途调用没有可靠用量：保留 132,096 token 预留，与已报告的
342 合计记账 132,438；这不是实际消耗声明。

## 本次修复

最初循环测试中，Node 发起的两项通过，Cloud 发起的两项失败：Node 已拒绝
第五跳，Cloud 却掩盖为 `CLOUD_TOOL_UNAVAILABLE`。现在仅为通过完整成员工具
schema 校验的 Group `ask_group_dot` 请求，传回六种明确的 HTTP 409 准入
拒绝码。未知正文、其他工具、非 Group、错误请求与传输失败保持通用不确定
错误；额外私有字段不返回。原有 `GROUP_MEMBER_CONTROL_NOT_CONSUMED` 不变。

workerd 专项 19 项包括 6 个原生场景、13 个错误映射与正文隔离场景。
完整 workerd 5 文件 86 项通过，无 uncaught/Unhandled。
更大范围结果见 [验证记录](validation.md)。

## 证据与范围

- [产品测试](../../../../tests/group-member-boundary-cloud-http.test.ts)
- [Cloud 工具测试](../../../../apps/cloud-agent/test/member-tools.test.ts)
- `group-isolation-*.json`：四组跨群快照、冻结输入、原生关联、模型区间与预算。
- `cycle-with-control-*.json`：四组原始链、用户更正、实际工具拒绝与失败终态。
- [核对脚本](validate.mjs)：源码 hash、数据关联、并发、canary、四跳期限与预算。
- [摘要](summary.json)：核对脚本生成的记录 hash 与统计，未替代 Runtime 执行。

执行 `node docs/verification/member-cloud-78/boundary-2026-10-25/validate.mjs`。
`artifact_integrity_ok` 只表示八份记录完整性；`full_acceptance_complete` 为 false。
Workspace/模型撤权、更广泛的模型故障与独立预算、同资源冲突、离线 Authority、
丢失工具 ACK、灰度关闭、自然真实模型对照、staging 和手机交互仍须继续验收。
