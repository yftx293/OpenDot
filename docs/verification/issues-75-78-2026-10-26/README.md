# #75–#78：本地完整回归记录

被测源码为 `a296b7c4726da20754d6a48375d0b5b9d30ce291`。本次队列于
2026-10-25 23:33:51 UTC 开始，2026-10-26 00:54:09 UTC 结束，最终退出码为 0。
启动时和全部门禁结束后，2064 个已跟踪文件的实际可读字节均与该提交一致。
本目录及链接更新是后续文档改动，不把本次运行改记为后续提交的完整测试。

## 实际结果

| 门禁 | 结果 |
| --- | --- |
| Node、Web、E2E、Runner 类型及文档检查 | 通过 |
| Worker 独立类型检查、Wrangler dry-run | 通过；没有部署 |
| Web、Runner 构建 | 通过 |
| workerd 完整套件 | 5 文件、86 项通过 |
| Authority 完整套件 | 24 文件、134 项通过 |
| Root 完整套件 | 436 文件、3367 项通过、23 项条件跳过 |
| 默认群聊浏览器套件 | 8 项通过 |
| 建群与导航浏览器套件 | 8 项通过 |
| 成员并发浏览器套件 | 1 项通过 |
| 单成员 Stop 浏览器套件 | 1 项通过 |

12 步的命令退出码和仓库错误日志门禁均为 0。浏览器四组共 18 项检查；
各层使用的场景和断言存在交集，不将各套件数字相加宣称独立产品能力数量。
完整命令、耗时、时间戳和日志 SHA-256 见 [complete-gates.json](complete-gates.json)。

Root 的 23 项跳过都位于 `tests/container-session-permissions.test.ts` 的已有
Docker 镜像可用性条件中。与之前完整通过的 `4ef4738` 相比，该文件的 Git blob
和跳过数量均未改变；其余单元/契约断言正常执行。这里没有 Docker 镜像内权限
集成通过的结论。具体条件和 blob 见 [root-manifest.json](root-manifest.json)。

## 证据与对应关系

- [source-audit.json](source-audit.json)：精确源码/tree、前后实际字节核对和分层结果。
- [authority-manifest.json](authority-manifest.json)：本次完整 Authority 运行产生的
  124 份原生场景 JSON 的文件名、字节数和 SHA-256。
- [root-manifest.json](root-manifest.json)：本次 Root 原生场景产生的 30 份 JSON 索引。
  这些是用例输出文件数量，不是新增测试数，也不是所有单元测试的逐项证据文件。

原始日志和完整原生记录保存在本机私有证据目录。索引不公开供应商配置、凭据、
会话 cookie 或用户数据库。本次新建群、来源、原始 input/Submission/Task、
更正、重启、预算、撤权、Stop 等断言均由实际套件执行；模型输出为受控 fixture。
原生投递 ACK 只证明接收，不代替实际消费或回答的断言。

先前失败仍保留：
[循环测试的因果驱动修复](../member-cloud-78/cycle-causality-2026-10-26/README.md)、
[收件箱吞吐失败及修复](../member-cloud-78/inbox-capacity-2026-10-26/README.md)。
更早 `b9e8fee` 的恢复超时在本次完整运行中未复现，最初原因仍未确定；
本次通过不能证明已经解释或修复了那次超时。

## 验收边界

本次证明本机 Node、local workerd 及隔离浏览器回归。手机宽度和键盘几何为
Chromium 仿真。当前 Chrome 的真实 WorkBuddy 单聊/群聊各三轮、生产 Cloudflare
staging、物理手机/输入法和当前提交远程 CI 仍未建立通过证据。
最新真实供应商尝试遇到 HTTP 429；受控模型通过不覆盖该失败。

[11 张较早 WorkBuddy 截图](../../screenshots/workbuddy-acceptance-2026-10-25/README.md)
仍对应 10 月 25 日已有用户构建和 relay-v1，单聊/群聊各三轮。
它们已保留在本次源码树中，与新成员 Inbox 模式及本次回归分开归属。

新模式保持默认关闭和显式 opt-in；旧 coordinator/relay Run、已保存策略、
权限、预算、原生来源和历史不迁移为新策略。上述待验收项继续开放。

可执行 `node docs/verification/issues-75-78-2026-10-26/validate.mjs` 检查本目录
索引的一致性。它只检查归档文件，不重新执行 Runtime 或浏览器验收。
