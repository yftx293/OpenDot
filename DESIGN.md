# OpenDot Design System

> OpenDot 的前端产品与视觉真相源。  
> 新增或修改 Web、PWA、Electron UI 前，必须先阅读本文档。

OpenDot 是 **Personal AI Assistant / Personal AI Team**，不是 Agent 管理后台。

设计目标：

> 用户打开 OpenDot 后，第一感受应该是“这是我的 AI 助手，我现在就可以和它说话”，而不是“这是一个需要配置的 Agent Dashboard”。

产品结构参考 Grok Bot 的 conversation-first 交互；视觉语法参考 MiniMax Design System 的清晰、轻盈、品牌蓝和统一 token；品牌身份使用 OpenDot 自己的 Dot / Bot Avatar。

---

## 1. Design DNA

OpenDot 的设计关键词：

- clean
- airy
- conversational
- personal
- playful
- restrained
- blue
- rounded
- native
- low-chrome

避免：

- dashboard-first
- card soup
- glass everywhere
- gradients everywhere
- neon
- heavy shadow
- engineering-console
- runtime-first UI

统一公式：

```text
Grok Bot
= Information Architecture

MiniMax-inspired Design System
= Color / Type / Radius / Spacing / Motion

OpenDot
= Brand Identity

OpenDot Runtime
= Hidden Infrastructure
```

---

## 2. Product Model: Dot First

用户理解的一级对象是 **Dot**。

```text
Dot
├── display name
├── avatar
├── personality / Agent Profile
├── model
├── memory
├── capabilities
├── conversations
└── goals / ongoing work
```

底层可以继续映射到：

- Agent Profile
- Workspace
- Product Session
- Pi Durable Conversation
- Goal
- Handoff

但普通用户不应该被迫理解这些底层对象。

### 2.1 Chief 不是用户名称

`Chief` 只允许作为内部 coordinator role / system role。

禁止在 UI 中硬编码：

```ts
profile.is_default ? 'Chief' : profile.name;
```

用户可见名称必须使用 Dot 自己的 `display_name`。

默认 Dot 也必须可以重命名，例如：

- Mini
- 研究助手
- 代码搭子
- 投资研究
- 内容创作

系统判断默认协调员使用稳定字段，例如：

- `is_default`
- role
- profile id

不要依赖字符串 `"Chief"`。

---

## 3. Information Architecture

### 3.1 Desktop

核心布局：

```text
┌────────────────────┬──────────────────────────────────────┐
│ Dot / Conversation │ Current conversation                 │
│ rail               │                                      │
│                    │ message timeline                     │
│ Mini               │                                      │
│ Researcher         │                                      │
│ Developer          │                                      │
│                    │                                      │
│ Group chats        │                                      │
│ Recent             │                                      │
│                    │                                      │
│ Work               │  ┌────────────────────────────────┐  │
│ Settings           │  │ Message your Dot...        ↑   │  │
└────────────────────┴──┴────────────────────────────────┴──┘
```

默认只保留两个主要视觉平面：

1. 左侧 Dot / Conversation rail
2. 中间 Conversation canvas

Context、Approval、Goal Detail、Tool Trace 是按需打开的 secondary surface，不是常驻第三栏。

### 3.2 Mobile

核心页面是完整聊天：

```text
Header
────────────────
Message timeline
...
...
────────────────
Composer
safe-area
```

活动会话中：

- 不显示常驻 Bottom Navigation 抢占 Composer 空间。
- 不把桌面 Sidebar 缩成窄栏。
- Secondary information 使用 Bottom Sheet。
- 用户应该能单手完成 Send / Approve / Deny / Mention。

---

## 4. Conversation First

OpenDot 的默认入口必须是一个真实 Conversation，而不是 Dashboard。

打开默认 Dot：

- 读取已有授权 Conversation。
- 不因打开页面创建新 Session。
- 不因 reconnect 自动提交输入。
- 空会话可以显示轻量 greeting。
- Composer 始终位于底部。

禁止把默认首页设计为：

```text
Composer
Running
Attention
Goals
Groups
Bots
Recent
```

这种纵向 Dashboard。

这些信息应该进入：

- left rail
- one-line inline status
- context panel
- sheet
- Work page
- attention badge

---

## 5. Composer Contract

Composer 是最重要的交互组件。

### Desktop

- 固定/docked 在 Conversation viewport 底部。
- 底部视觉间距：8–16px。
- 最大宽度建议 720–800px。
- Timeline 独立滚动。
- Timeline 的 bottom padding 必须至少等于 Composer 实际高度。
- Composer 高度变化不能推动整个页面重新布局。

### Mobile

- 对齐 `env(safe-area-inset-bottom)`。
- 键盘弹起时 Composer 仍然可见。
- 使用 visual viewport / keyboard observer 处理键盘，不要让整个聊天区域跳动。
- textarea 自动增高，但设置上限。
- `+`、`@`、Send 保持在自然拇指区域。
- 主要触控目标至少 44px。

### Mention

`@` 打开统一 Dot picker。

Desktop 使用轻量 popover。

Mobile 使用 Composer 上方 picker 或 Bottom Sheet。

用户输入的普通 `@name` 文本不能自动获得执行权限；mention metadata 继续使用现有受控逻辑。

---

## 6. Visual Tokens

以下是 OpenDot 的目标 token。新 UI 不应创建新的 ad-hoc 色值。

现有代码可以渐进迁移，但任何新组件必须优先使用语义 token。

### 6.1 Light

```css
--bg: #ffffff;
--surface: #fafafa;
--surface-2: #f0f0f0;

--fg: #222222;
--fg-strong: #18181b;
--muted: #45515e;
--meta: #8e8e93;

--border: #e5e7eb;
--border-soft: #f2f3f5;

--accent: #1456f0;
--accent-hover: #2563eb;
--accent-active: #1d4ed8;
--accent-on: #ffffff;

--success: #16a34a;
--warning: #eab308;
--danger: #dc2626;
```

### 6.2 Dark

Dark Mode 使用相同语义，不重新发明视觉风格：

```css
--bg: #111318;
--surface: #171a20;
--surface-2: #20242b;

--fg: #f3f5f7;
--fg-strong: #ffffff;
--muted: #a8b0bd;
--meta: #7f8998;

--border: #303641;
--border-soft: #252a32;

--accent: #8fb1ff;
--accent-hover: #abc3ff;
--accent-active: #c3d3ff;
```

Dark Mode 不使用高饱和 neon glow。

### 6.3 Color Rule

蓝色只负责：

- current Dot
- primary action
- send
- active navigation
- focus
- selected state
- working emphasis

普通内容主要使用黑 / 白 / 灰。

不要为每个功能分配一个品牌色。

---

## 7. Typography

建议统一：

```text
Display    Outfit
UI / Body  DM Sans
Code       SF Mono / JetBrains Mono / system monospace
```

中文使用系统高质量中文 sans fallback。

### Scale

```text
12px  metadata
14px  compact UI / navigation
16px  body / conversation
20px  small heading
24px  page heading
32px  major product heading
```

规则：

- 默认 `font-weight: 400/500`。
- 不要 everywhere `font-bold`。
- Display heading 才使用更明显的视觉重量。
- Conversation 正文优先可读性，不追求极高信息密度。

---

## 8. Spacing

基础单位：

```text
4
8
12
16
20
24
32
48
```

组件不得随意发明：

- 18px
- 22px
- 27px
- 34px

等一次性 spacing。

### Page Density

Conversation 页面比 Settings 更松。

Sidebar 比 Conversation 更密。

Approval / Sheet 保持清晰而不是尽量塞满。

---

## 9. Radius

只使用四档：

```text
8px     button / input / row hover
13px    composer / popover / compact surface
20px    sheet / modal / important surface
9999px  avatar / pill / status chip
```

禁止页面各自决定 `rounded-md/lg/xl/2xl`。

---

## 10. Elevation

默认是 flat。

```css
--elev-flat: none;
--elev-ring: 0 0 0 1px var(--border);
--elev-raised: 0 4px 6px rgb(0 0 0 / 0.08);
```

Shadow 只用于：

- popover
- sheet
- floating composer when necessary
- modal

不要在普通 Card、Bot Row、Goal Row 上使用明显阴影。

---

## 11. Motion

统一：

```css
--motion-fast: 150ms;
--motion-base: 200ms;
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
```

允许：

- hover
- selected state
- sheet
- popover
- context
- composer resize
- task-state transition

禁止：

- decorative bouncing
- full-page zoom
- infinite glowing border
- large spring animation

支持：

`prefers-reduced-motion`

---

## 12. Component Grammar

所有页面必须复用同一套视觉语法。

### 12.1 Dot / Conversation Row

```text
[Avatar]  Researcher
          Researching Cloudflare...

                                Working
```

相同 grammar 用于：

- Dot
- Conversation
- Group
- Goal participant

默认 flat row。

### 12.2 Message

聊天消息：

- 无大 Card 外壳。
- 用户和 Dot 名称小而清晰。
- 文本是视觉主体。
- timestamp / metadata 弱化。
- 连续 system event 自动收敛。

### 12.3 Task Status

```text
● Researcher · Working
○ Developer · Waiting for your Mac
✓ Report completed
```

状态是一行信息，不是一整张 Dashboard Card。

点击后才显示详情。

### 12.4 Approval

Approval 是少数允许显式 Surface 的对象：

```text
Developer needs access

README.md
MacBook Pro

Reason
Inspect the current implementation.

This permission applies only to this task.

Deny                       Allow once
```

### 12.5 Sheet

统一：

```text
Title
short description

content

primary / destructive action
```

不要每个页面自己设计 Modal。

---

## 13. Card Policy

默认不用 Card。

### Flat

以下默认 flat：

- message
- Dot row
- conversation row
- group row
- goal row
- work row
- settings section

### Card / Surface

以下才允许明显 surface：

- Approval
- Attention requiring action
- artifact preview
- modal
- sheet
- critical empty state
- elevated composer

目标：

> 如果一个页面出现五张以上明显 Card，先重新检查信息架构。

---

## 14. Sidebar / Rail

Desktop 只保留一个主 rail。

推荐顺序：

```text
Search          +

Dots
Mini
Researcher
Developer

Groups
Product Team
Research Team

Recent
...

────────────

Work          2
Settings
Profile
```

禁止同时展示：

- product nav rail
- workspace sidebar
- agent panel

三套一级导航。

Workspace 是实现细节，除高级配置外不要进入一级 IA。

### 14.1 Navigation continuity

- `+` 打开创建面板后，始终并列显示「新建 Dot」和「新建群聊」；切换类型保留各自草稿。
- 「Dot 和对话」查找已有 Dot、群聊与历史对话，不作为发现群聊创建入口的必经步骤。
- 「设置」打开设置目录；设置详情页明确提供「返回设置」，深链接和刷新后也能回到目录。
- 手机端设置详情使用一条带返回入口的上下文标题栏，不再叠加 Dot 一级导航栏。
- 操作反馈与重试入口留在当前弹层内；未确认的提交保留原标识，明确拒绝的提交允许修正。

---

## 15. Work / Goal

Work 是 secondary surface，不是首页 Dashboard。

```text
My Work

Running
Needs attention
Scheduled
Completed
```

Goal detail 可以展示：

- objective
- team
- progress
- evidence
- activity

不要优先展示：

- Runtime ID
- Handoff ID
- checkpoint
- lease
- receipt digest

这些放进 Advanced details。

---

## 16. Dot Avatar

应用 Logo 与 Dot Avatar 是两个层级。

### App Icon

静态品牌符号：

- OpenDot 机器人脸
- 深色圆角底
- 白色 shell
- 蓝色眼睛
- 克制

### Dot Avatar

每个 Dot 拥有长期稳定的个体身份。

优先级：

1. user uploaded image
2. explicit emoji
3. deterministic generated avatar

动画必须由真实 server-authoritative state 映射：

- idle
- working
- thinking
- waiting
- attention
- completed
- error

动画不能创造执行状态。

---

## 17. Mobile Rules

Mobile 是独立布局，不是 Desktop 缩小版。

### Active Conversation

只保留：

- compact header
- timeline
- composer

不显示：

- permanent bottom nav
- dashboard sections
- desktop context rail

### Secondary Actions

使用 Bottom Sheet：

- task detail
- approval
- device permission
- Dot detail
- Goal progress
- artifact
- advanced settings

### Safe Area

必须考虑：

- `safe-area-inset-top`
- `safe-area-inset-bottom`
- keyboard
- PWA standalone

---

## 18. Loading / Empty / Error

### Loading

优先：

- skeleton
- subtle inline status

不要全屏 spinner。

### Empty

必须说明：

1. 当前是什么
2. 为什么为空
3. 下一步是什么

### Error

区分：

- network
- permission
- device offline
- approval required
- runtime unavailable
- uncertain result

不要统一显示：

`Something went wrong`

---

## 19. Accessibility

必须满足：

- keyboard navigation
- visible focus
- 44px touch target
- semantic labels
- listbox / mention keyboard support
- sheet/dialog focus trap
- return focus
- reduced motion
- sufficient contrast
- no color-only status

Hover 不能是发现操作的唯一方式。

---

## 20. Forbidden Patterns

新增 UI 时禁止：

### Product

- 默认 Dot 名称硬编码为 Chief
- 打开首页先看到 Dashboard 再进入聊天
- 一级导航暴露 Runtime/JID/Harness/DO
- Workspace 成为普通用户一级产品对象

### Layout

- active chat 同时出现 BottomNav 和 Composer
- Composer 跟随页面滚动
- 三层以上常驻 sidebar
- message timeline 与页面整体一起滚动

### Visual

- 大量 rounded-2xl Card
- 多重玻璃拟态
- 大面积 gradient
- neon glow
- 每个状态一个高饱和色
- 普通 row 使用 shadow
- 页面自行硬编码品牌色

---

## 21. Review Checklist

所有前端 PR 必须回答：

### Product

- 用户是否能立即判断下一步做什么？
- 这是聊天产品还是 Dashboard？
- 有没有暴露本可隐藏的基础设施？

### Conversation

- Composer 是否永远在正确的底部位置？
- Timeline 是否独立滚动？
- 最后一条消息是否会被 Composer 遮挡？

### Mobile

- 390×844 是否可单手使用？
- 键盘打开后 Composer 是否可见？
- 是否出现双重底栏？
- Safe area 是否正确？

### Visual

- 是否复用了 token？
- 是否出现新的 ad-hoc radius / spacing / color？
- 能否删掉一个 Card / Border / Badge 而不损失信息？

### Semantics

- 状态是否来自 server authority？
- UI 是否偷偷推导权限？
- reconnect 是否可能重复提交？

---

## 22. Required Visual Evidence

涉及核心页面的 PR 至少提供：

### Desktop

- 1440×900
- light
- dark

### Mobile

- 390×844
- light
- dark
- active conversation
- keyboard/composer
- bottom sheet

截图只能证明视觉。

权限、恢复、提交幂等等仍需真实 E2E。

---

## 23. Geometry Acceptance

Conversation PR 必须自动验证：

### Desktop

- Composer bottom edge 距 conversation viewport 底部 ≤ 16px。
- Timeline bottom padding ≥ Composer 实际高度。
- 页面只存在一个 primary rail。
- Context 打开不导致 Composer 跳离底部。

### Mobile

- Composer 在 safe area 上方。
- active conversation 不显示 permanent bottom nav。
- 模拟键盘后 Composer 仍可见。
- 最后一条消息不会被输入框覆盖。
- Mention picker 在 Composer 上方打开。

---

## 24. Implementation Source of Truth

设计规范：

`DESIGN.md`

实际 token：

`web/src/styles/product.css`

组件：

`web/src/components/`

页面：

`web/src/pages/`

如果代码与本文档冲突：

- 新代码必须按本文档实现。
- 旧代码按后续 PR 渐进迁移。
- 不得为了兼容旧视觉继续扩散新的不一致。

---

## 25. References

视觉 token 与统一设计系统方法参考：

- MiniMax Design System / OpenDesign  
  https://open-design.ai/plugins/design-system-minimax/

产品信息架构参考：

- Grok Bot 的 conversation-first 交互模式
- OpenDot 用户提供的实际 Grok Bot 桌面端参考截图

这些是设计参考，不要求像素级复制任何第三方品牌。

---

## Final Rule

如果某个页面第一眼仍然像：

> AI Admin Dashboard

它就还没有完成。

OpenDot 应该第一眼像：

> **一个可以立即开始对话、长期陪伴、能持续完成工作的 Personal AI Assistant。**
