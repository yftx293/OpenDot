# 双账户原生上下文隔离 · #77

`108154dc578ad729b921b19574e962ce400860b3` 仅在 `4ef4738` 上新增隔离测试，未修改生产实现。
新增用例与完整 `group-member-inbox-controls-http.test.ts` 共 2 文件、9 项通过：
122.95 秒 Vitest、103.95 秒测试；仓库 uncaught/Unhandled 输出检查通过。

测试使用正常账户、登录、建 Dot、建会话与群聊 API，以及实际 Node Product/Pi
Durable。两个独立管理员账户也必须遵守私聊所有权。模型响应来自 loopback fixture，
不代表供应商、Chrome 实聊或生产 Cloudflare 验收。

另一账户先在自己的私聊产生一条带随机 canary 的真实原生输入与答案，确认该
canary 确实进入它自己的模型上下文。随后群内 Developer 尝试向该账户的 Dot
提问，目标被拒绝，不产生跨账户邮件或 Group×Dot Session；再向本群 Reviewer
发问。两个原生请求仍在执行时，额外检查：

| 操作                         | 实际结果 |
| ---------------------------- | -------- |
| 另一账户读取正在执行的群     | 404      |
| 另一账户向该群发送并触发讨论 | 404      |
| 群主列出另一账户的私聊       | 403      |
| 群主向另一账户的私聊提交输入 | 403      |

拒绝操作没有增加模型请求。Reviewer 的实际答案返回 Developer，最终完成原 Run；
问题、回答和最终结果各一条，临时答案不公开。群聊五次调用（Developer 四次、
Reviewer 一次），加上先前私聊一次，总计六次。另一账户的原生输入、digest、
Submission 和完成状态保持不变，canary 不进入群内模型或公开消息。

[原生记录](cross-user-private-native-context.json)保存冻结输入、原生关联、
投递和公开结果；私人 canary 只导出 hash。[门禁与记录 hash](gate-results.json)
固定测试源码、命令和结果。未导出登录 cookie、密码、真实用户数据或私聊正文。
同一账户的既有 private-canary 用例与本用例分别保留，不混为跨账户证明。

```bash
MINICLAW_MEMBER_PROOF_DIR=/absolute/private/evidence \
  node scripts/run-node-cli.mjs vitest run \
  tests/group-member-cross-user-http.test.ts \
  tests/group-member-inbox-controls-http.test.ts
```
