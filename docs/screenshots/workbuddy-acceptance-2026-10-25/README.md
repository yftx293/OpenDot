# WorkBuddy 实聊验收截图 · 2026-10-25

在 Google Chrome 中实际操作当前本地用户实例，使用已有默认模型 Magpie WorkBuddy
`workbuddy-ai/deepseek-v4.1-flash`。单聊与新建双 Dot 群聊各完成三轮，没有补发
纠错提示。本文保存原始截图，消息与来源核对记录见 [acceptance.json](acceptance.json)。

| 对话 | 第一轮余额 | 第二轮余额 | 第三轮余额 | 核对结果 |
| --- | --- | --- | --- | --- |
| 单聊：杉岚25 | 219 | 254 | 235 | 六条新消息，负责人和累计数据保持正确 |
| 群聊：海风25 | 144 | 169 | 155 | 三条用户消息、九条 Dot 回复，三次 Run completed |

群聊中 helson 先回答，Miniclaw 引用 helson 当轮的实际回复并复核，helson 收尾。
三次 Run 都是 `relay-v1`、协议 2，每次记录三次模型尝试。两个 Dot 各复用同一
群聊 Session。九条回复的 Input、Submission、Task、answer entry 和原生结果 digest
已与只读数据库核对。原生 digest 对应完整结构化答案，另存公开正文的 SHA-256，
没有把两者混为一谈；不公开原生私有控制信封或用户旧聊天。

## 手机宽度实聊

Chrome 视口为 390×844。第三轮前刷新，完成后再次刷新并从“Dot 和对话”搜索
找回同一个群，累计数据与回复仍在。

![单聊第三轮：预算295、已用60、余额235](single-mobile-three-rounds.jpg)

![群聊第三轮：两个Dot实际相互引用并核对余额155](group-mobile-third-round.jpg)

创建时一次选择两个 Dot，不出现“使用哪个 Dot 的对话环境”选择器：

![新建群聊同时勾选Miniclaw与helson](group-create-mobile.jpg)

## 桌面、深色和导航

![桌面群聊三轮后的结果](group-desktop-third-round.jpg)

其他原始截图：

- [手机深色](group-mobile-dark-ready.jpg)、[桌面深色](group-desktop-dark.jpg)
- [390×480 输入框获得焦点](group-mobile-dark-keyboard-height.jpg)
- [390×480 的 @Dot 选择器](group-mobile-dark-mention-keyboard.jpg)
- [消息详情中的时间与原生来源](message-details-desktop.jpg)
- [消息渠道返回设置侧栏](mobile-channel-return-settings.jpg)
- [最后一次刷新后的群聊](group-after-final-reload.jpg)

缩短视口时输入框位于 x=23、y=351、宽344、高66，底部417，小于视口480；
文档宽390，没有横向溢出。测试后清空 @ 草稿、恢复浅色与原视口。

## 证据范围与未通过项

- 这是已有本地实例的实际 WorkBuddy 实聊，不是受控模型 SSE fixture。测试时
  用户检出提交为 `42b55c89782553bb9d3cb7d0c5eaac7f9a73091c`；记录当时构建产物
  hash，但未证明产物与该提交一一对应，不能作为最新 #78 分支的运行验收。
- 群聊证明既有 `relay-v1` 接话体验，不代表新的 member-inbox UI 已验收。
- [浏览器检查](browser-checks.json)只覆盖观察到的有界事件窗口，包含截断，
  不是完整 HAR 或供应商请求追踪。观察到两次 `/favicon.ico` 404，控制台
  warning/error 为零，因此不声明所有 HTTP 请求通过。
- 手机宽度和缩短视口是桌面 Chrome 模拟，尚未覆盖物理手机与真实输入法。
- 本次没有捕获连续复用的 warm Container ID，不据此声明 warm IPC 验收通过。
- 没有部署 Cloudflare staging，也没有据此宣布 #75–#78 全部完成。

十一张截图保持原始像素，文件 hash 保存在验收 JSON。没有导出模型密钥、
登录 cookie、请求鉴权头或完整用户数据库。
