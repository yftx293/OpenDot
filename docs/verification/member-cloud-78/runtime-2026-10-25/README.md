# Cloud 成员 Run 验证记录（2026-10-25）

本目录来自隔离的产品 HTTP、Node Authority 和真实 local workerd/Pi SQLite。
模型推理和 HTTPS 主机名到回环地址的映射为可控 fixture，**不是 WorkBuddy 实聊或
生产 Cloudflare staging 验收**。没有读取用户运行中的会话或凭据。

实际从 quick-create Dot、创建群聊、owner 授予运行时/额外工具和显式启用新模式开始；
没有直接插入 grant、群消息、原生输入或完成状态来绕过产品入口。

## 四种组合

| 组合          | 问答调用数 / 峰值                                        | 停止后复用调用数 / 峰值                                            | 结果 |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | ---- |
| Node → Node   | [4 / 2](peer-node-durable-node-durable.json)             | [4 / 2](stop-and-reuse-node-durable-node-durable.json)             | 通过 |
| Node → Cloud  | [4 / 2](peer-node-durable-cloudflare-durable.json)       | [4 / 2](stop-and-reuse-node-durable-cloudflare-durable.json)       | 通过 |
| Cloud → Node  | [4 / 2](peer-cloudflare-durable-node-durable.json)       | [4 / 2](stop-and-reuse-cloudflare-durable-node-durable.json)       | 通过 |
| Cloud → Cloud | [4 / 2](peer-cloudflare-durable-cloudflare-durable.json) | [4 / 2](stop-and-reuse-cloudflare-durable-cloudflare-durable.json) | 通过 |

问答用例让 A 发出必要问题后继续独立工作，同时 B 正在回答。B 的真实回答先进入
原请求关联，再由 A 的后续原生输入实际消费；旧的临时答案不发布，最终结果仅一次。
峰值依据 provider fixture 的真实请求起止事件计算，不能等同于生产推理吞吐。

停止用例先取消两个正在等待模型的原生成员，再以相同持久 Session 开始新 Run。
旧 Stop 重放必须返回 409，不能取消新讨论。两次未知用量均按原预留值记账，
不是把取消或重启当作免费重试。

## 恢复、审批与用户指令

- [Cloud 双成员与 Node Authority 重启](peer-cloudflare-durable-cloudflare-durable-restart.json)：
  实际 SIGKILL/restart 后保留原 request/Submission，6 次调用、峰值 2；已知用量 152，
  两次未知用量保守预留后总记账 264344。重新签名的旧 owner 模型请求被拒绝且不再计调用。
- [审批与双端重建](cloud-approval-reconstruction.json)：Cloud 成员等待同一产物审批时，
  peer 可以完成独立工作；Worker 和 Node 重建后审批完成，3 次调用，无重复产物意图。
- [旧产物与排队更正](cloud-stale-artifact-correction.json)：实际原生队列收到新指令后，
  旧工具不能生成审批；2 次调用后按更正完成。
- [等待中的审批与用户更正](cloud-parked-approval-correction.json)：旧审批撤销，原生工具
  读取拒绝回执后进入新指令边界；2 次调用，没有产物执行。测试通过既有 owner
  决策 API 对已拒绝回执再次提交 deny 来唤醒，不代表已验证无人干预的自然 Alarm 延迟。
- [模型用量超过预留](cloud-reported-token-overrun.json)：保留模型报告的 200037 tokens，
  原讨论进入 `waiting_user`，只有 1 次调用，无成功结果发布或预算重置。

每个 JSON 包含运行时来源 SHA、Run/lease、冻结输入、原生答案关联、邮件关系、
模型 admission/传输关联、调用区间和审批结果。原生 owner 的本机实例标识只保留摘要。
[汇总](summary.json) 同时列出调用量、峰值、用量和各记录的 SHA256。

## 复跑与范围

```bash
npm --prefix apps/cloud-agent run build
MINICLAW_MEMBER_PROOF_DIR=/tmp/member-cloud-proof \
  npm run test:cloud-authority -- tests/group-member-cloud-http.test.ts
npm --prefix apps/cloud-agent test
```

本次专门采集通过 13 项产品场景。相关完整 Authority 配置为 9 文件、27 项通过；
guarded workerd 为 5 文件、71 项通过，无 uncaught/unhandled；旧 Node 成员控制与权限
回归为 2 文件、11 项通过。迁移/协议/账本专项为 7 文件、17 项通过。
完整 `make typecheck`、独立 Cloud 类型检查与 Wrangler dry-run 通过。
[验证范围及原始日志摘要](validation.json) 保留各项数量和日志 SHA256。
完整 Root suite、原始 `make build` 和 exact-head 远程 CI 仍未通过，不能以专项结果替代。

仍需完成所有组合的撤权、过期、跨群 canary、循环、资源冲突、单成员 Stop、
工具 ACK 丢失及离线 Authority 的完整矩阵，以及新分支的自然真实模型、staging、
桌面/手机端和完整发布验收。旧 WorkBuddy 截图属于之前的三轮实聊，不作为本目录
新模式的真实模型证据。模式保持默认关闭，#78 的完整发布验收尚未完成。
