# 成员生命周期验证（2026-10-25）

本目录使用隔离产品 HTTP、真实 Node Pi Durable 和 local workerd/PiHarness。
模型是可控 loopback provider，**不是 WorkBuddy、生产 Cloudflare staging 或真机验收**。
每例从实际创建 Dot、创建群聊、owner 授予明确额外能力、显式启用有界模式开始，
不提前插入 grant、群消息或原生完成状态。

| 组合          | 原问题过期                                                | 成员撤权与旧审批                                                    | 工作中收到用户更正                                              |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Node → Node   | [通过](expiry-node-durable-node-durable.json)             | [通过](revoked-approval-node-durable-node-durable.json)             | [通过](interjection-node-durable-node-durable.json)             |
| Node → Cloud  | [通过](expiry-node-durable-cloudflare-durable.json)       | [通过](revoked-approval-node-durable-cloudflare-durable.json)       | [通过](interjection-node-durable-cloudflare-durable.json)       |
| Cloud → Node  | [通过](expiry-cloudflare-durable-node-durable.json)       | [通过](revoked-approval-cloudflare-durable-node-durable.json)       | [通过](interjection-cloudflare-durable-node-durable.json)       |
| Cloud → Cloud | [通过](expiry-cloudflare-durable-cloudflare-durable.json) | [通过](revoked-approval-cloudflare-durable-cloudflare-durable.json) | [通过](interjection-cloudflare-durable-cloudflare-durable.json) |

## 更正后的回答来自哪个 Task

新增用例复现：两个 Dot 同时工作，用户要求只检查预览、禁止部署或创建产物后，
Reviewer 的旧原生回答仍先发布到群聊，新原生 Task 按更正完成的回答却被丢弃。
修复后，原问题在最新更正的原生完成回执出现前保持待答，期间不发布旧回答。

记录保留原问题 Task 的真实完成结果；最终邮件明确引用另一个更正输入的
Product input、Submission、Task、answer entry。更正输入必须完整包含原问题，
原 `in_reply_to`、deadline 和所有旧 payload/digest 均保留。公共修正回答和
Developer 的最终回答各一次，旧产物请求没有创建审批。

用例实际等待更正后的 Reviewer 调用，核对旧原生答案已经完成但尚未回传，
再释放真实后续答案。本目录四个更正用例各有 6 次模型调用，包含控制和 peer 消费。
若原生边界将 peer 输入与更正合并到同次生成，测试也允许 5 次，但仍核对实际消费、
最新限制和最终回复唯一性，不使用空转模型来等待消息。

## 撤权与过期

撤权用例先进入真实原生产物审批，再经 owner API 禁用接收成员。原讨论失败、
原生 owner 静止、审批变为 denied/revoked；旧 approve 返回 409，没有产物文件。
Node/Cloud 仍使用各自执行主机，没有回退到 Mac。

过期采用明确的短 TTL 故障注入：在隔离 Node 子进程内，将新邮件 TTL 的单个
编译常量从 120000ms 改为 10000ms，记录原始与执行 JavaScript 的 SHA256。
**没有等待生产 120 秒期限，因此不能把本记录称为生产 TTL 的实耗时验证。**
不改墙钟、签名有效期、邮件期限字段或磁盘 dist；两端使用真实时间。
到期保留原 deadline，原讨论失败，两位原生执行停止，没有迟到答案或最终结果。

两类终止场景都保持 3 次实际模型调用。保留的 Cloud 原请求重新签名后，返回
明确执行拒绝（`GROUP_DISCUSSION_TURN_NOT_ACTIVE`），不会误按普通模型请求解析。
Node→Node 没有 Cloud 模型重放；它验证实际 HTTP 连接中断后无可释放的旧输出。
未知用量保留原预算记账，不能将中止调用计为零成本。

## 复跑和证据范围

这十二份记录来自 `9b56d41488bbe04f8ca6b0d3a4d01300c8bda3cf`。
后续 Cloud 准入拒绝码修复改变了其中的 Worker 源码 hash；旧记录未改写。
核对这些历史记录时应使用该提交的源码，新运行应写到另一个证据目录。
当前增量的独立记录见 [跨群隔离与循环通信](../boundary-2026-10-25/README.md)。

```bash
npm --prefix apps/cloud-agent run build
MINICLAW_MEMBER_PROOF_DIR=/tmp/member-lifecycle-proof \
  npm run test:cloud-authority -- tests/group-member-lifecycle-cloud-http.test.ts
node docs/verification/member-cloud-78/lifecycle-2026-10-25/validate.mjs
```

12 项当前专项通过，原始日志、此前失败复现和类型检查的摘要见
[验证记录](validation.json)。每个 JSON 保留来源 SHA、原生输入/答案、邮件、
公共 timeline、模型调用区间、预算和审批；不含凭据或私有主机实例标识。
[只读校验器](validate.mjs) 核对文件来源和上述结果，输出的
`artifact_integrity_ok` 仅代表这些记录一致，`full_acceptance_complete` 仍为 false。

完整 Authority 回归通过：11 文件、49 项，726.46 秒；日志没有 uncaught/unhandled。
最终 make typecheck 通过，包含后端、Web、E2E、Runner、同步和文档检查。
Node 成员控制/权限/Stop、迁移、准入和 Cloud Authority 单元回归也通过：
11 文件、44 项，223.64 秒；日志没有 uncaught/unhandled。
本机 npx/concurrently 和 Vite 入口被 shell 误解析的问题已由后续 Node CLI
启动修复清除，完整 make build 通过；失败退出和 SIGTERM 转发也已核对。
最初失败与最终成功的日志摘要均保留在验证记录中。
#75–#78 的全部发布验收仍未完成：跨群 canary、
循环、模型错误/预算/资源冲突的全部组合、离线 Authority/工具 ACK 的完整矩阵，
新模式自然真实模型、旧 relay 对照、生产 staging、物理手机及完整 Root/CI
门禁仍需继续。旧 WorkBuddy 三轮截图保持原来的范围，不作为本目录新模式证据。
