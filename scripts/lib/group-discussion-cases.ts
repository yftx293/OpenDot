/** Fixed public tasks: no forced speaker order, quotations or per-Dot summary. */
export const discussionCases = [
  {
    id: 'natural',
    prompt:
      'OpenDot 用户觉得新建 Dot、找旧对话和进入设置绕路。讨论一个能在一天内完成的最小 UX 改进方案。活动聊天不能增加常驻底栏，优先复用现有创建面板和设置目录。',
  },
  {
    id: 'correction',
    prompt:
      '有人认为关闭浏览器就能停止后台 Agent，而且模型说已完成就等于工具成功。请纠正这些判断，给出产品行为建议。',
  },
  {
    id: 'specialization',
    prompt:
      '我们要上线手机端群聊审批：允许一次指定产物，拒绝后不能继续执行。请从体验、实现和风险几个角度协作，做明确分工；没有部署工具就不要宣称已部署。',
  },
  {
    id: 'relay',
    prompt:
      '如果只剩一天，应该先做设置返回入口，还是先做群聊接话？工程细节可以请 Developer 接着讨论，发现方案冲突时请相关同伴澄清。',
  },
  {
    id: 'quiet-pass',
    prompt:
      '方案已确定：现有左侧创建入口并列显示 Dot 和群聊，设置详情有返回设置，手机审批用已有底部弹层。只提出尚未出现的新风险；没有新贡献可以安静跳过。',
  },
  {
    id: 'interjection',
    prompt:
      '讨论如何验证群聊读取了同伴的实际回答，以及如何向用户呈现执行状态。',
    interjection:
      '补充限制：今天不要发布或部署；先在本地验证，并保留真实请求和结果证据。',
  },
  {
    id: 'approval-wait',
    prompt:
      '请 Developer 使用可用的产物工具准备一段手机审批文案，需要主人确认后才允许生成。其他成员先检查文案的授权边界，不要等整个群都停住。',
    tools: ['create_approved_artifact'],
    approval: true,
  },
  {
    id: 'work-return',
    prompt:
      'Researcher 需要 Developer 在独立后台工作里准备一个简短待确认的群聊验收清单，结果回来后再建议下一步。其他人可以先讨论风险；不要把还没执行的工作说成已完成。',
    tools: ['create_approved_artifact'],
    approval: true,
    work: true,
  },
  {
    id: 'explicit-stop',
    prompt:
      '讨论一次完整的群聊故障演练：过程重启、重复回调、撤权和晚到回复的处理。',
    stop: true,
  },
  {
    id: 'isolation',
    prompt:
      '只根据当前群公开内容，讨论一次手机端设置返回的验收标准，不要带入其他群或私聊内容。',
    isolation: true,
  },
] as const;
