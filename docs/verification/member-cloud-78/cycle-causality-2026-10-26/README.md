# 原生循环用例的入队竞态 · 2026-10-26

修复测试驱动的因果前提：释放挂起模型前，等待原问题的原生 Submission 回执；
随后从实际 provider 输入检查父问题和用户纠正已进入上下文。生产跳数、期限、
授权、预算和调度代码保持原样。实现提交为 `63614924555915cff52ef1addd9bd52dbe9ccda4`。

## 首次失败及原因

完整 Authority 在诊断提交 `b5a36c5` 上返回退出码 1：100 项通过、1 项失败；
`--bail=1` 停止剩余用例，Root 和四组浏览器门禁没有执行。耗时为
1876.61 秒 Vitest / 1878.14 秒命令，输出检查为 0。
[原门禁结果](failed-complete-authority-b5.json)保留失败，没有用后续专项覆盖。

Node→Cloud 循环预期四跳，实际为 `1,2,2,3`。失败发生在用户插话之前，
`control_epoch=0`。第 7 次实际 provider 请求只含最初的第一跳问题，
B 随后发送的分支计算为第二跳符合其真实输入。测试只等待模型调用次数，
没有等第三跳问题在 B 的原生队列中登记，因而误把并行分支当成连续因果链。

- [原始失败记录](first-failed-cycle-node-cloud.json)
- [对应输入与发送来源诊断](diagnosis.json)

入队回执仍不等于模型已读。修复同时增加每次提问的实际父问题断言，
以及第五次 A 请求中的真实用户纠正断言。四跳、同一期限、冻结输入不变、
十次模型调用、迟到结果与 Stop 栅栏检查全部保留。

## 专项复测

[完整专项门禁](repair-gates.json)对应实现提交 `6361492`，三步及输出检查均为 0：

| 命令范围                                                        | 结果                                           | Vitest / 命令耗时  |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------------ |
| `make typecheck`                                                | 全部类型、共享拷贝、提示词、101 份文档检查通过 | 62.27 秒命令       |
| Authority 配置下完整 `group-member-boundary-cloud-http.test.ts` | 8 项通过，四组合隔离与循环                     | 111.55 / 112.53 秒 |
| Root 配置下完整 `group-member-inbox-controls-http.test.ts`      | 8 项通过                                       | 113.32 / 114.32 秒 |

四份修复后原生循环记录：

- [Node→Node](cycle-with-control-node-durable-node-durable.json)
- [Node→Cloud](cycle-with-control-node-durable-cloudflare-durable.json)
- [Cloud→Node](cycle-with-control-cloudflare-durable-node-durable.json)
- [Cloud→Cloud](cycle-with-control-cloudflare-durable-cloudflare-durable.json)

每份包含真实 Tool Task 来源、原生输入关联、实际 provider envelope、
冻结 mail 身份和最终拒绝回执。可运行 `node validate.mjs` 检查文件哈希、
关联一致性及原始失败的实际输入。该校验不重新执行模型或 Runtime。

## 范围

这是受控 provider 与实际 Node Pi Durable / 本地 workerd 的证据。
新的完整 Authority/Root/浏览器回归仍需执行；本目录不是完整回归通过声明。
更早 `b9e8fee` 的效果恢复用例失败仍缺少错误栈，原因未明，本次测试竞态
不能解释该失败。既有 WorkBuddy 实聊截图、当前供应商 429、生产 Cloudflare
和物理手机验收保持各自范围；新模式继续默认关闭。
