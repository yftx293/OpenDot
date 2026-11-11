# Node 双成员原生问答证据（2026-10-25）

生产 HTTP、Product Runtime 与 Pi Durable 1.3.0，使用本次隔离的可控模型，非供应商实聊。
全部用户、Dot、Run、消息和输入身份均来自测试临时数据库。
文件保存冻结公开输入、真实 provider 输入摘要、原生 Task/Submission、投递来源、最终结果与计量关联；不含凭据。

- [未完成的发送者、真实回复与用户纠正](unfinished-sender-reply-and-correction.json)：完成，4 次调用。
- [丢失 ACK 与重复用户命令](lost-ack.json)：完成，1 次调用，原请求关联修复。
- [SIGKILL 后恢复原输入](restart-original-inputs.json)：完成，6 次调用，包含实际重试。
- [Stop 栅栏后重启与关闭开关](restart-stop-gray-off.json)：取消，原生输入 unanswered，任务 terminal，1 次调用。
- [默认关闭、跨群拒绝、撤销成员](live-removal-and-default-off.json)：撤权后明确失败并停止，2 次调用；不是运行失败被当成成功。

每份记录含关键源文件 SHA-256。验收范围、既有完整门禁失败与剩余工作见
[实现及验证记录](../../../member-inbox-node-77.md)。
