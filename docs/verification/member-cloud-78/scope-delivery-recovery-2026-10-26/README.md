# Workspace 撤权、成员回执与 Authority 离线 · #77–#78

冻结源码 `89e5e4d3e569eaf8019e8417bd45a2693240cdd3` 的三个完整原生测试文件
共 18 项通过：318.69 秒测试、337.83 秒 Vitest、338.80 秒命令。仓库输出检查通过。
完整 `make typecheck` 通过（69.26 秒），运行中的 1,995 个跟踪文件与提交逐字节一致。
这组测试使用实际 Node Pi Durable、本地 workerd PiHarness 和受控模型 SSE，
真实厂商调用为零，不能替代 Chrome 实聊、生产 Cloudflare 或物理手机验收。

| 场景                             | Node→Node  | Node→Cloud | Cloud→Node | Cloud→Cloud             |
| -------------------------------- | ---------- | ---------- | ---------- | ----------------------- |
| Workspace 改绑到另一 Dot         | 通过       | 通过       | 通过       | 通过                    |
| 提问和回复的原生成功回执分别丢失 | 通过       | 通过       | 通过       | 通过                    |
| 实际终止 Authority 后恢复        | 本组未执行 | 本组未执行 | 通过       | 通过，离线时重建 Worker |

另外完整复跑了原有的模型禁用、Host 工作区合约撤回八项用例。上表不是把
两项离线测试扩写为四种 placement 均已验证。

## 两处生产修复

**改绑 Workspace 后，旧模型请求被误报为临时故障。** 测试通过正常 API 将
Reviewer 工作区改绑到 Developer。在途 Run 已正确失败、原审批已撤销，但
重放旧 Cloud 模型请求得到 503。现在 Runtime 配置身份变化使用已有的
`ProductRuntimeConflict`，沿用原有 4xx 映射；没有按错误文案猜测权限失败。
四种组合均拒绝旧审批和模型请求，原生 owner 收敛，恢复原绑定也不会自动重启
已失败的 Run。每例保持三次调用、原问题和冻结输入，产物没有执行。

**Cloud 恢复退避尚未结束，同伴回复已耗尽投递重试。** 新的 Cloud→Node
用例真实 SIGKILL 隔离 Authority。Cloud 的模型连接中断并进入原生恢复；
Authority 回来后 Node 同伴先完成，回复在 Cloud 的 Alarm 恢复之前连续投递，
导致 `GROUP_MEMBER_DELIVERY_UNCERTAIN`。原失败记录保留。

现在在领取投递重试前读取现有的签名 Cloud snapshot：只有同一成员 Run、
同一 lease、正在等待且尚未耗尽的原生恢复，才暂缓这次投递。读取不启动 owner，
其他成员仍可推进。模型预算、原问题期限、三次投递上限、八次恢复上限和旧协议
均保持原值；未知传输状态仍走已有有界处理，没有新 Scheduler 或执行主机替换。

两项离线测试均观察到实际 `ECONNREFUSED`。Authority 离线时经过 4.1 秒安静窗口，
调用仍为三次，没有发布答案；Cloud→Cloud 在离线期间另重建 Worker。
恢复后两者都沿用原 input/request/Submission、Group×Dot Session 和问题因果，
以六次调用完成；原中断请求的未知 token 用量保守保留，答案唯一。

## 回执丢失与测试修正

每种 placement 都在同一个 Run 中分别丢弃提问、回复的成功 ACK。Node 故障
发生在实际 ProductRuntime.submit 返回之后；Cloud 故障发生在实际 Worker 返回
202 和原生 Submission 回执之后，桥接器只丢弃这次响应。并未伪造原生接收。
每例最终严格四次模型请求，原问题、同伴回复和最终答案各发布一次；临时答案
不公开，Node/Worker 重建后输入关联与调用量不变。

首个探针错误期待 Cloud HTTP 200，实际契约为 202；随后两例过早在成员关联
建立时检查 Product Submission，而原生回执尚未写回。本次加强等待条件，要求
原生 Submission 已关联再检查唯一性。没有延长测试期限或放宽原始 ID、因果、
调用次数与发布断言。这两类测试观察错误与上面的生产离线故障分别记录。

## 证据和复跑

[manifest.json](manifest.json) 固定 18 份原始隔离记录及三个历史失败记录的 hash、
源码和结果；[gate-results.json](gate-results.json) 保留原始失败、后续复测、完整
类型检查和专项测试的命令、退出码、时长与日志 hash。记录中的 failed Run 是
撤权用例要求的安全终态，不代表测试失败。未导出密钥、cookie 或用户聊天数据。

```bash
npm run test:cloud-authority -- tests/group-member-policy-cloud-http.test.ts tests/group-member-input-ack-cloud-http.test.ts tests/group-member-authority-offline-cloud-http.test.ts
make typecheck
```

复跑需要先构建当前 Worker dry-run bundle。后续在冻结的文档提交 `4ef4738`
完成了全部 11 步队列，生产和测试源码与上面的 `89e5e4d` 一致：Root 435 文件、
3361 项通过、23 项既有跳过；Authority 21 文件、120 项通过；workerd 5 文件、
86 项通过；创建/导航浏览器 8 项、成员并发 1 项、成员 Stop 1 项通过。
类型检查、Worker 独立类型检查、Worker dry-run、Web 与 Runner 构建均通过，
每一步输出检查通过。命令、耗时和原始日志 hash 见
[完整队列](complete-gates-4ef.json)。
[Authority 记录索引](complete-authority-manifest-4ef.json)核对了 109 份隔离记录
及其 24 个源码 hash；记录数不等于测试数，不能将重复快照的调用量相加。
该索引固定本地保留记录的 hash，不宣称此目录发布了全部 109 份原始记录。

后续 `108154d` 仅新增[双账户隔离用例](../../member-inbox-77/cross-user-2026-10-26/README.md)，
其专项结果与冻结 `4ef4738` 的完整队列分别记录，不将后者改记为新提交的完整 Root。
新模式继续默认关闭，当前版本的真实模型三轮 Chrome 验收仍未通过；已有
[WorkBuddy 实聊截图](../../../screenshots/workbuddy-acceptance-2026-10-25/README.md)
保留其较早用户实例的范围，不据此关闭 #75–#78 或宣称全量发布完成。
