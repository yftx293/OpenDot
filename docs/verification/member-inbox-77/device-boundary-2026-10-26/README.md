# 设备离线与成员讨论权限边界 · #77

同一双 Dot 群聊中，已有授权的 Cloud Goal 正等待离线设备文件时，尝试开启成员
讨论会返回 `409 / GROUP_DISCUSSION_DEVICE_REQUIRES_GOAL`。提示现在明确说明
设备权限属于工作任务，并给出普通群聊的配置方向。

`58f5dfa` 的完整 Device 集成文件两项通过：41.79 秒 Vitest、21.92 秒测试，
输出检查通过。`325421e` 的完整类型检查、3 文件 15 项客户端/呈现回归、Web
生产构建与默认群聊八项浏览器检查也通过。后续只加强 Device 测试断言，生产
代码未变，见[源码、命令和日志 hash](gate-results.json)。这是专项结果，未改记
父版本的完整 Root/Authority 门禁。

## 同群实际边界

测试通过正常 API 配对并批准一个只声明 `research.txt` 的本地 Device，加入第二位
可参与讨论的 Dot，再创建仅选择原 Cloud Dot 的 Goal。设备尚未发送 heartbeat，
服务端实际投影为 `active / online=false / last_seen_at=null`。
人工授权精确文件后，原工作任务进入 `waiting_for_device`。

| 阶段                          | 已验证结果                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Goal 等待设备时开启双成员讨论 | 明确拒绝；群版本保持 17，讨论设置未变                                                            |
| 原有工作授权                  | grant ID、运行位置和工具列表未变，无自动撤回或扩权                                               |
| 原生分配                      | 原来的一个 input/request/Submission/digest 完全一致；无新的讨论、成员 lease 或 Group×Dot Session |
| 模型调用                      | 拒绝前后仍只有原来的一次调用，无额外原生投递                                                     |
| 设备上线                      | 精确读取原文件；本地缓存使重复命令返回相同结果                                                   |
| 回执丢失和 Worker 重建        | 原请求、Handoff、Product input、Submission 与 Device Tool Task 保持关联                          |
| 最终完成                      | 原 Goal 完成，实际文件结果经精确审批产生工件，总计三次模型调用                                   |

[原始隔离记录](goal-device-offline-member-boundary.json)保留输入身份、原生关联、
拒绝结果、授权与文件 hash，不导出文件正文、设备 token、配对码或 Provider 密钥。
第二项既有 Device 撤权/暂停/取消回归仍按原断言执行；未增加测试期限或绕过授权。

模型输出来自 loopback fixture，实际使用生产 Node、local workerd/PiHarness 和
Device 文件读取器。设备传输由隔离测试驱动；不是物理设备、实际 Cloudflare 或
供应商推理验收。**直接在成员讨论里执行 Device 工具仍不支持**；此处证明原工作
任务的离线恢复与成员准入隔离，不能标成成员 Device 执行成功。

```bash
MINICLAW_MEMBER_PROOF_DIR=/absolute/private/evidence \
  node scripts/run-node-cli.mjs vitest run \
  --config vitest.cloud-authority.config.ts tests/cloud-device.integration.ts
```

运行前需有当前 Worker dry-run bundle。真实模型三轮、部署与真机状态分别记录，
新模式继续默认关闭。

## Cloudflare staging 预检

当前只读 `wrangler whoami` 明确显示未认证，虽然命令退出码是 0；不能据此判为
Cloud 验收通过。当前进程缺少四个 live-test 安全绑定，也未设置 staging 授权标记。
实际 live 脚本返回 `Pending / exit 2 / secure_environment_binding_missing`，请求为零。
见[仅含安全元数据的预检](staging-readiness.json)。没有搜索或导出开发者其他凭据，
没有创建 Worker/DO、部署或执行供应商请求。待有明确的测试目标及安全绑定后，
仍需单独完成产品成员链路的 staging 验收，PoC live 检查不能替代它。
