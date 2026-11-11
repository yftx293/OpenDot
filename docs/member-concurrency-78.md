# 多 Dot 有界并发（#78，开发中）

本变更依赖 #77 的成员 Inbox 和原生 Pi Session 关联。本页记录 Node 切片与
后续 Node 实聊，仍默认关闭；Cloud 适配及部分混合 Runtime 证据另见
[Cloud 成员记录](member-cloud-78.md)，全量发布验收尚未完成。

## 行为与边界

同时设置 `MINICLAW_GROUP_MEMBER_INBOX=true` 和
`MINICLAW_GROUP_MEMBER_CONCURRENCY=true` 后，新的成员模式讨论可选择 2–8 个 Dot。
创建群聊与保存讨论设置不调用模型。明确 @ 的成员各自接收冻结输入；
没有点名时仅先响应的 Dot 开始，其余成员按实际问题或后续 @ 加入。
普通用户插话不会唤醒所有空闲成员。

同一 Product/Pi Session 仍只有一个原生 owner。复用已有
`ProductRuntimeService` 和讨论服务；没有新增任务调度器或 Host 进程池。
容量限制只作用于此模式的模型请求，等待审批、等待成员回答不占模型位置，
也不会把尚未结束的原生 Task 标记为已完成。

每个新 Run 冻结版本 1 限制：

| 范围                            | 限制                         |
| ------------------------------- | ---------------------------- |
| 群聊中的活跃模型调用            | 2                            |
| 同一 owner 的活跃模型调用       | 4                            |
| 同一成员 Session 的活跃模型调用 | 1                            |
| owner 的排队请求                | 32                           |
| 单次排队时间                    | 最多 90 秒，且不超过讨论期限 |
| 单次请求 token 预留             | 最多 262144                  |
| 讨论累计 token                  | 2000000                      |
| owner 最近 24 小时 token        | 8000000                      |
| owner 最近 24 小时实际模型请求  | 256                          |

继续沿用原有每 Run、每成员模型尝试次数、输入/邮件条数与字节数、
最多四跳、邮件期限及投递重试限制。排队不计作实际模型请求；
真正发出请求前才绑定已有的原生 Task/尝试/输入来源并扣除调用次数。
FIFO 只在容量就绪的请求间生效，拥堵群聊不会阻塞另一可运行群聊。

## 更正、结果与计量

用户插话生成新的冻结 control 输入，不覆盖原始 payload。
敏感工具必须核对当前原生生成实际收到的输入内容，包含最新用户指令，
才可创建审批或读取额外资源。仅获取新的 control epoch 不代表读过更正。
早于未处理更正或成员回答的旧最终结论不发布；后续实际读取后的回答按
原生 answer entry 去重回写。

模型结束后记录有效的正整数 usage。只有成功且用量明确时释放未用预留；
失败、中断或缺少可信 usage 时按完整预留计量。超出预留的报告仍持久保存，
然后暂停讨论，不能丢弃超支或继续声称成功。
恢复时只有取得原生 Session owner 后，才把旧进程的实际请求记录为 uncertain，
按完整预留计量并释放模型位置。Stop 同样需要真实原生终止证明。

## 迁移与灰度

Schema 增加不可变的 Run policy、模型容量/用量凭据和索引，使用既有升级前备份
与拒绝降级机制。旧 coordinator/relay/member Run 不补写新策略，不改 frozen
payload，不放宽旧 owner 或 pending-turn 约束。

关闭新开关仅阻止新模式准入；有已冻结策略的 Run 仍可 reconcile/stop。
不要通过清空 Inbox、预算、来源或原生 checkpoint 回滚。

## 当前验证状态

已在隔离 Node 实例复现并修复两种用户更正竞态：过时工具创建审批、
过时模型结论先于更正发布。测试断言实际原生输入、调用次数、审批记录、
最终消息唯一性和原始输入字节保持不变。模型输出为受控本机 fixture，
不能作为 WorkBuddy 或其他真实模型验收。

本地 Node 回归 9 个文件、42 项通过（461.58 秒），覆盖新模式九个真实原生竞态场景，
以及旧成员问答、更正、审批、撤权、模型计量和升级备份。命令、来源 hash 及九份新增
证据见 [Node 记录](verification/member-concurrency-78/node-2026-10-25/validation.json)。
个人 Agent、Web 与浏览器测试 TypeScript 检查通过，Web production 构建通过。

三成员 Playwright 产品用例通过；修正“请选择两位”的旧提示并增加断言后再次通过。
实际 Chrome 从手机多选创建到问答汇总、刷新、桌面 Stop、键盘高度与深浅色检查已完成；
调用为受控推理，不冒充自然模型结果。[Chrome 截图及观测限制](screenshots/member-concurrency-78-2026-10-25/README.md)
保留静态 favicon 404 和后续网络窗口截断事实。
`make typecheck` 全部通过，包含 Runner、共享类型、Prompt 和文档检查。
原始 `make build` 在本机的 `concurrently` 启动脚本处失败：JavaScript 被作为 shell 解释，
编译器尚未执行。随后使用 Node 直接调用相同 TypeScript/Vite 入口，后端、Web、Runner
三项构建分别通过；不将这个替代结果描述为原始 Make 命令通过。

父分支 `97c4` 的 CI [run 127](https://github.com/helsome/OpenDot/actions/runs/40130523548)
为 failure，三个 job 的步骤与日志均不可读，原因未确认。上述属于该阶段记录；后续父实现的
[完整本地门禁](verification/runtime-gates-2026-10-25.md) 已通过，但不能代替当前
改动的完整回归或远程 CI。

后续授权模型 Node 验收已完成三轮：实际同伴问答与中途更正、两位独立续聊、
重启后的持久状态均核对通过，10 次请求、60,407 已报告 token。旧 relay 对照首轮
仍有 Reviewer 按旧快照回答，那个整体比较未通过。详见
[真实 Node 记录与限制](verification/member-concurrency-78/real-node-2026-10-25/README.md)。
Cloud 适配和 local workerd 的后续实现/证据见 [Cloud 成员记录](member-cloud-78.md)；
随后修复串行发言 Dot 的过期结果发布与控制，并用同一授权配置重新完成两个模式
各三轮；20 次真实请求、模拟请求 0，两位作者最终数字均正确。旧原生结果与新的
queue 输入/Task 单独保留，未改写旧失败记录。详见
[更正修复与三轮对照](verification/member-concurrency-78/serial-correction-2026-10-25/README.md)。
当前提交的 Chrome、生产 staging、物理手机、更广自然任务与完整发布门禁仍未通过，
不关闭 #78，也不默认开启。

原有 WorkBuddy 三轮单聊/双 Dot 群聊截图是独立证据，见
[原始实聊记录](screenshots/workbuddy-acceptance-2026-10-24/README.md)。
