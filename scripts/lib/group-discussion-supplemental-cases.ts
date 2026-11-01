/** Explicit controls complement the immutable initial ten-case study. */
export const supplementalDiscussionCases = [
  {
    id: 'closed-pass',
    prompt:
      '以下三项已验收完成，本轮没有待定问题：创建入口区分 Dot 与群聊，设置详情用显式路径返回设置，手机审批复用已有底部弹层。本轮只确认这三项，不扩展新需求、不假设额外风险、不重复已确认信息；没有新增有效信息时请安静 PASS。',
    requireQuietPass: true,
  },
] as const;
