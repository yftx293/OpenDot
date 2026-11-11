# Cloud 成员通信基础层验证（2026-10-25）

这组记录是原生能力和签名工具通道的验证；Cloud 成员产品准入仍未开放。
不代表 Node→Cloud、Cloud→Node 或 Cloud→Cloud 群聊完成，也不代表真实模型、
生产 Cloudflare、Chrome 或物理手机验收。原 WorkBuddy 三轮实聊证据保持独立。

- [原生来源和签名工具回执](native-source-and-tool-wire.json)：实际 Node Product Adapter 与 workerd SQLite 的原生 Harness。followUp/steer 分别只在实际边界包含新输入；过期任务和错误 scope 被拒绝。Authority 使用可控签名 fixture，四个工具场景覆盖准备/原生 memo/提交、伪造绑定、已消费公共上下文和未来上下文拒绝。
- [用户更正后的提问栅栏](explicit-members-consume-correction-before-question.json)：Node 产品 HTTP 与真实 Pi Durable，推理为可控 fixture。修复前旧调用仍发送两条问题，修复后零 peer mail、零审批、三份唯一最终回复、六次模型请求；冻结的原始输入不变。
- [类型修改的等价记录](type-only-equivalence.json)：保留 46 项回归时的原始来源 hash。之后移除未使用的类型 import，编译 JS 的 SHA256 完全一致；不重写历史回执中的来源 hash。共享来源接口随后只调整类型声明空白。

专项命令：

```bash
node node_modules/vitest/vitest.mjs run tests/pi-durable-tool-source.test.ts tests/cloud-member-protocol.test.ts
npm --prefix apps/cloud-agent test -- --silent=false --reporter=verbose
```

Node 专项回归共 11 文件 46 项；workerd 共 5 文件 67 项。后续类型清理和格式整理后，Node 3 项、workerd 6 项再次通过。现有 Cloud 产品 HTTP/Handoff 的 3 文件 7 项集成回归也通过，覆盖重启、丢失 ACK、撤权与停止。
`make typecheck` 和 `node scripts/check-cloud-standalone.mjs` 通过；后者明确在无根目录依赖的临时副本中检查，不部署。
初始 workerd 日志有五次 `CLOUD_EXECUTION_SUSPENDED` uncaught 启动拒绝及预期的损坏输入负向拒绝；后续启动恢复与空闲 owner 修复不改写这组历史来源记录。
因此此证据不能作为完整 CI 或日志无错误的声明。Cloud 产品契约、统一计量、恢复、混合矩阵和真实 staging 仍待完成。

## 后续启动恢复修复

[启动恢复证据](startup-recovery.json) 对应后续源码与测试 hash；不重写前面原生工具证据。
启动授权被拒和空闲撤权重连分别先复现为 500，再修复。一个输入/原生 Task 保留，
拒绝重试和 DO 重建不重置次数或步数；恢复后只追加一次模型请求。原有损坏回执场景
仍返回原本的 503，没有更改旧安全断言来获取绿色。

最终标准 npm test：workerd 5 文件 69 项通过，零 uncaught/Unhandled；实际 Node Authority
与 workerd 的完整集成配置 8 文件 14 项通过。故意破坏 checkpoint 的预期拒绝仍保留。
Cloud-only 类型检查和 Wrangler dry-run 通过，无部署。

这验证现有 managed Goal/Handoff 恢复与空闲产品 Session；新 Group 成员 Cloud 契约、
统一计量、混合矩阵和真实部署验收仍未完成。GitHub CI 尚未执行有效检查，不能据此合入发布。
