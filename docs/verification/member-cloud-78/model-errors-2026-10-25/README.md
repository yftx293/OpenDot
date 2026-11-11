# #78：成员模型拒绝与超量用量

Node→Node、Node→Cloud、Cloud→Node、Cloud→Cloud 分别覆盖 HTTP 400、
HTTP 401 与超出本轮 token 额度的返回，共 12 项通过。使用实际产品 HTTP
建群和授权、Node Pi Durable、local workerd PiHarness、SQLite 与原生
Submission/Task；provider 错误及用量由隔离 fixture 控制。
这不代表 WorkBuddy、真实 Cloudflare 或物理手机验收，新模式仍默认关闭。

## 复现与修复

Developer 通过原生工具向 Reviewer 发送一个随机问题，随后继续在途模型调用；
Reviewer 已通过自己的原生输入读取问题时，分别返回明确请求拒绝、认证拒绝，
或已报告用量 200,037 token 的回答。两位成员当时确实重叠执行。

最初的四项 HTTP 400 测试中，Node 接收方两项通过，Cloud 接收方两项失败。
Cloud 代理将明确的 provider 拒绝转换为 HTTP 503，原生恢复逻辑反复重新打开
同一次调用。失败记录包含第七次实际请求，尚未结束，而不是正常模型重试。

现在仅将明确的非暂时性 HTTP 4xx 返回为安全的
`400 / CLOUD_MODEL_REQUEST_REJECTED`；不透传 provider 私有错误正文。
HTTP 408、429、5xx 与传输错误仍保留原有恢复和不确定用量处理。
旧 Handoff/Goal 模型代理未改动。

原生重试策略保持原样：Node 当前 Pi 默认允许三次重试，接收方共四个 attempt；
Cloud Harness 明确禁用模型错误重试，接收方共一个 attempt。
测试核对各自策略下同一原生 Task 的准确 attempt 序列，不要求两者次数相同。

## 最终结果

| 模式            | 接收方       | 每组总调用 | 终态                     | 已报告 / 保守记账 token |
| --------------- | ------------ | ---------: | ------------------------ | ----------------------: |
| HTTP 400 或 401 | Node         |          6 | failed，原生输入失败     |            38 / 660,518 |
| HTTP 400 或 401 | Cloud        |          3 | failed，原生输入失败     |            38 / 264,230 |
| 超量用量        | 任一 Runtime |          3 | waiting_user，token 限额 |       200,075 / 332,171 |

保守记账包含没有可靠最终用量的在途或拒绝请求的原有预留，不能当作实际消耗。
超量回答本身的 200,037 token 按报告值记账；失败或超量不会凭空发布同伴回答。

每项均核对：原问题 ID、原始 delivery request、来源 input/工具 Task、期限和跳数
不变；两份冻结 payload 及 digest 不变；没有替换问题输入、回复邮件或最终消息；
成员 lease 全部结束，模型准入无 active/waiting，Cloud attempt 无 started；
群并发峰值为二，每个成员 Session 峰值为一，原始预算关联保留。
不确定状态仍明确保留，不会被标成成功。

## 复跑与证据

```bash
npm run test:cloud-authority -- tests/group-member-failures-cloud-http.test.ts
node docs/verification/member-cloud-78/model-errors-2026-10-25/validate.mjs
```

第一条命令运行实际产品用例，第二条只核对本目录已记录的证据。
`peer-*.json` 是通过后直接保存的 12 份原始记录；源码 hash 包括实际代理、
Harness、Node Runtime、锁文件和测试。核对脚本生成 [摘要](summary.json)，
`artifact_integrity_ok` 表示记录完整性，`full_acceptance_complete` 继续为 false。
门禁及失败历史见 [验证记录](validation.md)。

这一步覆盖明确请求/认证拒绝及报告用量超额；更广泛的独立预算、暂时性故障、
Workspace/模型撤权、资源冲突、离线 Authority、丢失工具 ACK、灰度关闭、
自然真实模型对照和发布环境仍需继续验收。
