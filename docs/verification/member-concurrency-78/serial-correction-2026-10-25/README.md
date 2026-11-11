# 用户更正后的串行群聊修复与真实三轮复测

实现来源为 [`12a0f0f`](https://github.com/helsome/OpenDot/commit/12a0f0fd1817866850fa48ac91050cbb560ba1e6)，
见 [PR #96](https://github.com/helsome/OpenDot/pull/96)。使用用户已授权的本机
Magpie → WorkBuddy 配置，经实际产品 HTTP、持久 Node Pi Session 和原生 Task 执行。
隔离实例通过正常 API 创建两个 Dot、群聊、授权和设置，没有预先写入期望消息或 grant。

## 复现与修复

此前 [旧 relay 对照](../real-node-2026-10-25/README.md) 中，用户在 Reviewer
生成时取消了印刷支出 14，但 Reviewer 仍发布已用 102、剩余 208，Developer
随后才给出 88、222。那个整体失败记录保持不变。

原有过期结果检查只覆盖协调 Dot。本次将检查扩展到串行发言 Dot：保留原生已完成
输入、Task、结果来源和 decision，阻止旧公开回复、接力和委派生效；由同一 Dot
在同一 Session 中接收新的普通 queue 输入，读取补充后重新回答。原调用和发言分配
仍计入预算；总次数、每个 Dot 次数或模型预算不足时明确等待用户。Run policy、
protocol、deadline、grant 和原冻结输入均不重置，没有修改成员 Inbox、Schema 或默认开关。

受控模型 SSE 的 HTTP 测试先复现失败，再检查两个旧协议、过期委派与接力、
原输入完整性、新 Task 身份、重复更正请求、重启持久性和三个预算限制。
Cloud 用例运行实际 workerd/SQLite/Session；推理和本机 HTTPS 路由是 fixture。

## 真实模型结果

本次组合脚本退出 0，20 次真实请求，模拟请求 0。两种模式均在同一群、同两位
Dot 和同两条持久 Session 内完成三轮；第三轮前重启隔离后端，旧消息和 Session
不变，没有重启后自动推理或完成后追加回答。

| 模式                     | 三轮请求数 | Provider 已报告 token | 同时生成峰值 | 各轮最终答案   |
| ------------------------ | ---------- | --------------------- | ------------ | -------------- |
| member-inbox-v1          | 6 / 2 / 2  | 65,060                | 2            | 两位作者均正确 |
| 修复后的 serial relay-v1 | 4 / 3 / 3  | 63,401                | 1            | 两位作者均正确 |

三轮核对的「总预算 / 累计已用 / 剩余」分别为 `310 / 88 / 222`、
`310 / 111 / 199`、`293 / 111 / 182`，随机项目名与负责人林岚保持一致。
串行首轮确实产生旧的 102/208 原生结果，记录显示它未发布；随后 Reviewer
使用不同 input/request/Task，读到更正后给出 88/222，Developer 最终也正确。
两个模式均未出现同作者完全相同的重复回答。

这是一个自然任务的联合协议、上下文和调度测量，不能推广速度、质量或成本优势。
token 表为 Provider usage；本次成功报告没有另导出成员计费台账，不能据此声称已
逐项证明此次 token 的产品计费。完整来源、实际公开回答、原生 ID、调用区间及重启
记录见 [机器证据](api-three-turns.json)，同公式指标见 [summary.json](summary.json)。

## 本地门禁与范围

- 完整 `make typecheck` 和标准 `make build` 均退出 0。
- Node 群聊回归 5 文件、43 项通过；独立工作 1 文件、3 项通过。
- Cloud 串行群聊 1 文件、4 项通过，包含新更正用例及原停止/恢复/独立工作检查。
- Cloud 的 npm 构建入口因本机脚本解释器失败，保留退出 2；使用现有 Node 启动器
  调用同一 Wrangler dry-run 后退出 0，没有部署。命令与日志 hash 见
  [gate-results.json](gate-results.json)。
- 后续针对冻结的 `34c17f4` 完整执行：Authority 13 文件、70 项通过；标准 Root
  435 文件全部通过，3352 项通过、23 项既有跳过。两份完整日志均通过仓库的
  uncaught/Unhandled 检查；执行前所有 tracked 文件字节与该提交完全相同。
  原实现与实际推理来源仍是 `12a0f0f`，没有将后续门禁来源覆盖到旧推理记录。
  [完整本地门禁](../../runtime-gates-2026-10-25.md) 与远程 CI 分别记录。

运行 `node docs/verification/member-concurrency-78/serial-correction-2026-10-25/validate.mjs`
检查记录完整性、固定源码 hash、作者/算术、原生来源、更正前后 Task 和指标；
这不会重新调用模型。真实复测使用 `node --import tsx scripts/test-group-member-live.ts`，
需私有 `MINICLAW_GROUP_MODEL_CONFIG` 与 `MINICLAW_GROUP_EVIDENCE_PATH`，会产生实际调用。

这是 API 实聊记录。Mac 仍锁定，当前提交未进行 Chrome 验收；没有生产 Cloudflare
staging、物理手机或当前界面截图证明。历史
[WorkBuddy Chrome 截图](../../../screenshots/workbuddy-acceptance-2026-10-24/README.md)
属于独立验收。#75–#78 仍未完成全部发布验收，不据此关闭 issue、合并整个栈或默认开启新模式。
