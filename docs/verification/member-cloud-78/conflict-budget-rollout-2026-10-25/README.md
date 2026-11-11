# 资源冲突、独立预算与关闭准入 · #78

20 项完整原生产品测试通过。每项从实际 API 建群、选择两个 Dot、保存权限和
启用 member-inbox 开始，执行 Node Pi Durable / 本地 workerd PiHarness；只有模型
SSE 是受控 fixture。没有厂商推理、Chrome 或生产 Cloudflare 验收声明。

| 场景 | Node→Node | Node→Cloud | Cloud→Node | Cloud→Cloud |
| --- | --- | --- | --- | --- |
| 已落盘产物被其他写入者改变 | 通过 | 通过 | 通过 | 通过 |
| 单成员调用预算耗尽 | 通过 | 通过 | 通过 | 通过 |
| 整个 Run 调用预算耗尽 | 通过 | 通过 | 通过 | 通过 |
| 关闭准入后恢复已接收的工作 | 通过 | 通过 | 通过 | 通过 |
| 关闭准入后停止已接收的工作 | 通过 | 通过 | 通过 | 通过 |

## 修复的两处产品问题

**Cloud 工具的不确定状态没有及时结束群聊。** 真实审批后的文件已经 fsync、
校验完成，但回执尚未确认时退出隔离 Authority；另一个受控文件系统写入者只
修改此 fixture 的产物。恢复后原审批正确进入 uncertain，文件没有被覆盖，但
原实现仍等待同伴直到消息过期。现在只在当前成员的原生工具证明通过校验、
该产物工具返回 uncertain 时，将对应 Run 明确结束为
`GROUP_MEMBER_EFFECT_UNCERTAIN`，沿用原生 Stop 收敛，没有新调度器。

同样的冲突在 Node 接收者中可作为实际 Tool 错误被模型消费，产生明确的负面
同伴回复与结论；Cloud 接收者保持不确定执行的停止边界，直接给出上述错误。
两种结果都不能宣称文件写入成功。测试中的其他写入者是文件系统故障注入，
不是第二个 Dot 的真实写操作；没有放宽资源、Workspace 或审批权限。

**Cloud 单成员预算耗尽被误报为输入失败。** Worker 原有本地硬上限在第三次
推理之前拒绝调用，但 Authority 没收到原因，原实现输出
`GROUP_MEMBER_NATIVE_INPUT_FAILED`。现在拒绝仍在本地发生，通过原有签名模型
通道附带只诊断的 `local_budget_exhausted` 标记。Authority 核对原成员/Run 账本，
确认耗尽后沿用既有预算等待与停止路径；标记请求绝不转发给供应商、不新增计费。
若账本仍有预算，返回 `CLOUD_MEMBER_MODEL_BUDGET_CONFLICT`，不允许调用方编造
暂停理由。两个 Cloud 同伴用例包含这项反向探针。

八项预算用例在 A 提问后继续生成、B 正在生成时插入用户纠正，再要求下一次
推理。最终全都明确 `waiting_user / GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED`，
每例严格三次实际模型请求：A 两次、B 一次。Run、原问题、冻结输入、期限、
grant 与调用/并发/token 配额均保留；停止并重建后没有新增推理或虚假的答案。

## 关闭灰度后的行为

八项用例在两个实际模型请求在途时退出隔离 Authority，重建 Worker，并在
配置中关闭 Node 的三项 member 准入开关与 Worker 的新 Session 准入。没有修改
已持久 Run 的策略、预算或原生 checkpoint，没有切换执行主机。

四项恢复用例仍消费原问题、发布真实原生回复并完成原 Run，每例六次模拟请求。
四项停止用例经实际群聊 Stop API 收敛到 cancelled，没有同伴/最终答案。随后
新消息的 dispatch 得到 4xx，不保存新消息或启动模型；再次重建仍保留终态。
两次被中断模型的未知用量继续保守预留，不把释放并发名额当作费用为零。

## 来源、失败与门禁

资源冲突记录固定实现 `64ebbfc`；预算与关闭准入固定 `7b1edb2`。
[manifest.json](manifest.json) 为每一份原始记录固定独立源码、测试、原生来源与
文件 hash，没有将修复前日志的来源改写成新代码。20 份 JSON 是隐私检查后的
原始隔离记录，未修改结果。保存记录的检查命令为：

```bash
node docs/verification/member-cloud-78/conflict-budget-rollout-2026-10-25/validate.mjs
```

检查覆盖四种 placement、原问题/产品 input/Submission 关联、冻结输入、模型
调用区间与预算、冲突文件身份和终止结果。每 Session 的 HTTP 模型并发不超 1、
Group 不超 2；预算/关闭准入用例实际同时持有两个模型请求。资源冲突用例持有
模型与审批/工具，不要求两次模型同时在途。Cloud 来源数组也可能包含被拒绝
的诊断请求，实际推理数量以 provider 输入与付费尝试关联核对。

这只验证保存证据，不重新执行运行时、磁盘故障或模型。
[validation.json](validation.json) 汇总 20 例、84 次模拟请求、1,900 已报告 token，
未知用量预留后保守计量合计 4,493,164；各例 owner 独立，不是用户的供应商账单。

完整文件实际结果：资源冲突 4 项通过，预算 8 项通过，关闭准入 8 项通过。
三份原生日志均通过仓库 uncaught/Unhandled 输出检查。修复前资源冲突为 2 通过 /
2 失败，预算为 6 通过 / 2 失败；原日志保留，hash 和源码见
[gate-results.json](gate-results.json)。第一条 Worker 构建命令路径错误，没有构建，
修正为已有 Node CLI 后 dry-run 成功；未将命令错误当作产品失败或部署结果。

预算实现的完整类型检查通过。父版本完整 Authority 90 项通过、Root 三项失败
及三个完整文件 31 项复测通过见[父版本门禁](../policy-2026-10-25/README.md)。
集成后的新完整 Authority/Root 门禁仍待执行，不能把专项 20 项或父版本结果
当作当前完整通过。远程 CI 保持手动触发，没有 exact-head 远程 CI 通过声明。

第一次集成队列在 `e379ba2` 上完成完整 `make typecheck`，随后独立 Worker 类型
检查发现新增诊断请求的 `Request.clone()` 泛型不兼容，队列在原生完整测试前停止。
`0ac72f2` 改为直接传递该只使用一次的请求，保留同一 body 与取消信号；没有移除
类型检查。原失败、日志 hash 与队列阶段保留在门禁 JSON，新的完整结果仍待执行。

## 用户实例实聊

已有用户实例的[WorkBuddy 单聊和群聊各三轮及十一张原始截图](../../../screenshots/workbuddy-acceptance-2026-10-25/README.md)
单独记录 Chrome 操作、数据与原生来源；该实例不是上述 member-inbox 测试构建。
手机使用桌面 Chrome 视口模拟，有界网络记录中有 favicon 404，没有真机或全量
HTTP 通过声明。当前 member-inbox UI、物理手机与部署 staging 的发布验收仍未完成。
默认新模式保持关闭；本记录不关闭 #75–#78 的完整目标。
