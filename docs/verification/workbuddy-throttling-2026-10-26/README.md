# WorkBuddy 429 错误提示修复 · 2026-10-26

当前版本 Chrome 实聊首次请求遇到四次真实上游 HTTP 429，随后页面空闲，
只有用户消息，没有助手回复和错误提示。原始截图与失败记录保留在
[PR #100 的验收目录](https://github.com/helsome/OpenDot/tree/cc82920/docs/screenshots/workbuddy-current-2026-10-26)。

Pi 的错误帧没有显式 providerFailure 标记；既有兼容分类器漏掉
`rate_limit_error` 的下划线边界和仅含 HTTP 429 的错误。修复仅补充错误通道
匹配，沿用现有供应商失败处理、中文终止提示和进程停止流程。成功回复中
正常解释 429、显式 providerFailure:false、本地错误中的行号 429 保持原行为。

## 测试

先在未修复实现上复现：原生 Host HTTP 用例等不到错误提示，另有六项分类
断言失败，共 7 失败、53 通过。日志 hash 与断言范围保留在
[gate-results.json](gate-results.json)。测试的进程关闭观察在首次到达之前，
从不存在的占位日志修正为现有 Host Agent 关闭日志；提示断言和产品超时未放宽。

最终源版本 `5038a636a3ff541286febd56cbfcda3643405ac5`：

- 完整运行七个相关测试文件，100 项通过，Vitest 66.98 秒，命令 68.09 秒。
- 原生 Host Pi 用例使用受控 HTTP 429 响应，经过实际 SDK 与生产后端。
  核对一条原始输入、一条持久化中文错误提示、最多四次请求及实际进程关闭；
  重启后端并重新读取原对话，观察超过两个正常消息轮询周期，没有新增请求或消息。
- `make typecheck` 通过，包含后端、personal-agent、Web、E2E、runner、共享类型、
  prompt 引用和文档一致性；命令 69.59 秒。两个命令的异常输出检查均通过。

首轮修复已经通过相同 100 项检查，随后将重启观察从一秒加强到
`2 * POLL_INTERVAL + 100` 毫秒，再按最终提交完整复测；原有 180 秒用例截止不变。

这里的 HTTP 错误回归是受控供应商测试，不是 WorkBuddy 实聊通过。真实模型
首次 429 失败记录保持不变，尚未对修复版本完成新的单聊和群聊三轮验收，
也未宣称最新完整 Root、远程 CI、物理手机、warm IPC 或 Cloudflare staging 通过。
用户原有服务和模型配置没有修改。
