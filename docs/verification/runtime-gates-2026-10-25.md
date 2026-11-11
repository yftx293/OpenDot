# #75–#78：完整本地回归门禁修复

此记录区分已完成的检查与仍运行的完整回归，不代替成员新模式的全部产品验收。

## 修复与已有结果

标准 `make test` 最初尚未执行测试就失败：本机将 `.bin/vitest` 的 JavaScript
当作 shell 运行，报 `import: command not found`。沿用此前构建修复的 Node
启动方式，把 helper 改为 `scripts/run-node-cli.mjs`，测试和构建统一通过已安装
包的 `package.json#bin` 定位入口并以当前 Node 执行。参数、信号和退出码保留，
不安装另一版本、不修改依赖锁、不放宽运行时或测试期限。

首次真正执行完整 Root：434 文件，430 通过、4 失败；3,365 项中 3,337 通过、
5 失败、23 跳过，1,420.01 秒。此前的启动、恢复、备份与 ownership 超时没有
重现。本次五项失败已逐项修复：

- 专门的数据库版本审查门继续使用显式当前版本，并指向现有加性迁移/私有备份
  测试；没有删除版本审查门。两个历史升级 fixture 的最终持久版本改为跟随
  `CURRENT_SCHEMA_VERSION`，原有资料、grant 和历史记录保护断言保留。
- 用现有 generator 从未修改的 `assets/miniclaw-icon.svg` 重新导出 9 个 Web PNG
  与 Electron PNG/ICNS。源 SVG 和设计未变，图标像素一致性恢复。
  只在 managed checkout 写入；原用户 checkout 的 11 个未提交图标 hash 不变。

四个相关文件的 10 项测试全部通过，21.09 秒。标准 `make typecheck` 通过，
52.74 秒；标准 `make build` 三个目标全部退出 0，93.19 秒。随后新增的 Cloud
产品测试已单独通过 Personal Agent 类型检查，Worker 独立依赖检查与 dry-run
也通过；Cloud 的独立验收范围见
[Cloud 成员通信](../member-cloud-78.md)，这些结果单独归属对应改动。

## 当前完整门禁

首次最终 Authority 为 56 项通过、1 项失败：旧 Cloud 续聊用例默认约一秒的
轮询没有等到异步结果提交。独立复跑通过后，增加一次结果回传 503，并改为
等待同一请求的真实 Node HTTP 提交；加强后的用例通过，原有终态、队列、
停止和重启断言及整个用例期限保留。详见
[Cloud 验证记录](member-cloud-78/boundary-2026-10-25/validation.md)。

后续 `a187764` 对应的完整本地门禁已经结束：完整类型检查退出 0，87.67 秒；
标准构建退出 0，148.84 秒；Authority 13 文件、69 项通过，1251.49 秒，
uncaught/Unhandled 输出检查也通过。标准 `make test` 为 434 文件全部通过、
3342 项通过、23 项既有跳过，2016.37 秒。没有新增跳过项或放宽旧用例期限。
此前五个群聊 HTTP 超时的失败历史仍保留；本次完整通过不证明系统冷启动耗时
在所有宿主机上恒定，也没有据不确定的目录微基准改写运行时。
机器可读结果与原始本地日志 hash 见
[模型故障门禁记录](member-cloud-78/model-errors-2026-10-25/gate-results.json)。

`a187764` 的 [CI 138](https://github.com/helsome/OpenDot/actions/runs/40173518325)
三个 job 均失败，接口没有返回步骤和可下载日志；本次页面 annotation 原因未确认。
较早运行确认过的账号限制不当作本次已确认原因。完整本地检查不能代替远程 CI。
#75–#78 的全部目标仍在推进，
不据此合并 Draft PR、默认开启新成员模式或关闭发布验收项。

## 串行更正后的完整门禁

`34c17f4` 对应 `12a0f0f` 的用户更正修复与已保存的真实模型记录。执行前核对了
所有 tracked 文件的实际字节，未在运行中改写源码或重启测试。完整 Authority
13 文件、70 项通过，990.36 秒（命令 991.90 秒）；标准 `make test` 为 435 文件
全部通过、3352 项通过和 23 项既有跳过，1549.47 秒（命令 1552.12 秒）。两份
完整日志均通过 `apps/cloud-agent/scripts/test-runtime.mjs --check-log`，目标 Node、
Cloud 与真实模型日志也通过同一检查。受控负向用例中的预期容器/帧错误仍保留。

标准类型检查和构建已对实现来源 `12a0f0f` 通过；此后至 `34c17f4` 仅整理证据文档。
完整命令、各自来源和日志 hash 见
[更正修复门禁](member-concurrency-78/serial-correction-2026-10-25/gate-results.json)。
Main 已通过 #94 将 CI 改为仅手动触发；没有当前提交的远程 CI 通过证明，也没有
因本地通过恢复自动触发。当前 Chrome、部署 staging 与更广故障矩阵仍单独待验收，
这些完整本地门禁不代表 #75–#78 已全部完成。
