# 同一已有群聊的追加授权与撤权（2026-10-25）

使用实际生产 HTTP、Node / Product / Pi Durable / SQLite，模型为隔离 loopback 可控响应。
不是供应商实聊，不代表 Cloud 或物理手机。三个原生权限测试先用默认权限完成首轮，再更新已有 Group×Dot 的授权；下列记录来自最终整合回归：15 个文件、72 项通过（495.30 秒）。
每份证据含关键运行时 source_sha256，以及 tests/group-member-inbox-permissions-http.test.ts 的 test_source_sha256。

| 场景                                                                                                        | 预期终态  | 本 Run 模型尝试 |
| ----------------------------------------------------------------------------------------------------------- | --------- | --------------- |
| [after-live-grant-remove-fresh-consent](after-live-grant-remove-fresh-consent.json)                         | completed | 2               |
| [after-live-grant-replace-fresh-consent](after-live-grant-replace-fresh-consent.json)                       | completed | 2               |
| [existing-session-added-permission](existing-session-added-permission.json)                                 | completed | 5               |
| [existing-session-removed-permission-after-restart](existing-session-removed-permission-after-restart.json) | completed | 2               |
| [live-grant-remove-fenced](live-grant-remove-fenced.json)                                                   | failed    | 1               |
| [live-grant-replace-fenced](live-grant-replace-fenced.json)                                                 | failed    | 1               |

追加权限后的 Run 使用原 Session/Conversation，精确审批通过才创建文件，然后真实消费同伴回答。
移除权限并重启后仍保留原 Session/Conversation；模型即使尝试调用未授权工具，也没有产生新审批或产物，之后普通对话完成。
运行中换发授权（无论保留还是移除工具）均先使旧 Run 失败并停止，原因明确为 GROUP_DISCUSSION_GRANT_CHANGED。
旧审批为 denied/revoked，旧产物不存在；下一 Run 使用同一 Session，但必须提出新内容并取得新审批。
模型请求总列表包含同一 fixture 的前序 Run；run.model_attempts 与 model_dispatches 才是本 Run 的实际计量。

失败历史：最初追加授权在推理前报 SESSION_IDENTITY_CHANGED；第一轮补测还暴露撤权被泛化为 NATIVE_INPUT_FAILED。
修复没有改写旧 origin、grant、frozen payload 或旧原生 Task，未提升既有测试超时。
[实现与完整门禁限制](../../../member-inbox-node-77.md)。
