const messages: Record<string, string> = {
  BOT_GROUP_FEEDBACK_CONFLICT: '反馈已更新，请刷新后重试。',
  GROUP_DISCUSSION_EMPTY_MODEL_OUTPUT:
    '模型没有返回可显示的正文，讨论已停止。请检查模型输出上限后重新发起。',
  GROUP_MEMBER_STOP_UNAVAILABLE:
    '这位 Dot 当前没有可单独停止的回复，请刷新群聊后重试。',
  GROUP_MEMBER_STOPPED: '这位 Dot 已停止本轮回复，请在本次讨论结束后重新发起。',
  BOT_GROUP_REVISION_CONFLICT: '群聊状态刚刚更新，请重试。你的输入已保留。',
  BOT_GROUP_WORKSPACE_UNAVAILABLE: '请先新建一个 Dot，再创建群聊。',
  BOT_GROUP_PROFILE_UNAVAILABLE: '所选 Dot 已不可用，请更新选择后重试。',
  BOT_HANDOFF_RUNTIME_DISABLED: '当前服务尚未开启群聊对话，请检查运行配置。',
  GROUP_DISCUSSION_DISABLED: '当前服务尚未开启群聊对话，请检查运行配置。',
  BOT_HANDOFF_RUNTIME_CONFIGURATION_UNAVAILABLE:
    '有 Dot 的模型或对话配置未就绪，请先打开该 Dot 的对话检查配置后重试。',
  BOT_HANDOFF_SCOPE_REQUIRED: 'Dot 尚未准备好对话，请重新开启群聊讨论后重试。',
  GROUP_DISCUSSION_GRANT_REQUIRED:
    'Dot 的对话配置需要更新，请重新开启群聊讨论后重试。',
  GROUP_DISCUSSION_DEVICE_REQUIRES_GOAL:
    '设备文件权限仅用于已授权的工作任务。请通过工作页使用设备；普通群聊需将这位 Dot 的权限设为不含设备工具。',
  BOT_GROUP_CHAT_TOOL_REVIEW_REQUIRED:
    '额外工具权限已过期或发生变化，请在高级设置中更新。普通对话不会自动续开工具。',
  GROUP_MEMBER_ADMISSION_DISABLED:
    '当前服务尚未开启边工作边提问，可切回按轮讨论。已开始的协作仍可恢复或停止。',
  GROUP_MEMBER_REQUIRES_TWO_DOTS:
    '请为这项实验协作选择两位 Dot，并包含先响应的 Dot。',
  GROUP_MEMBER_NODE_ONLY: '这项实验协作目前只支持在此服务器运行的 Dot。',
  GROUP_MEMBER_RECIPIENT_UNAVAILABLE:
    '提问对象必须是本次协作中另一位已选的 Dot。',
  GROUP_MEMBER_SESSION_BUSY:
    'Dot 的上一项群内任务尚未结束，请先等待或停止原任务。',
  GROUP_MEMBER_EXECUTION_FENCED:
    '这次协作已停止或成员配置已变化，请刷新核对后再继续。',
  GROUP_MEMBER_DELIVERY_EXPIRED: '等待成员回复已超时，本次协作已结束。',
  GROUP_MEMBER_DELIVERY_UNCERTAIN:
    '尚未确认原消息的投递结果，请刷新核对原任务，避免重复发起。',
  GROUP_MEMBER_INBOX_LIMIT:
    '本次协作的消息已达到上限。请停止本轮，缩小任务范围后重新发起。',
  GROUP_MEMBER_MESSAGE_LIMIT: '这次提问内容过长，请缩短后重新发送。',
  GROUP_MEMBER_CONTEXT_LIMIT:
    '本次协作需要读取的内容过长，请缩小任务范围后重试。',
  GROUP_MEMBER_RESULT_LIMIT:
    'Dot 的回复超过本次协作的长度上限，请缩小任务范围后重试。',
  GROUP_MEMBER_HOP_LIMIT: '成员连续互相提问已达到本次协作的上限。',
  GROUP_MEMBER_MESSAGE_BUDGET_EXHAUSTED: '本次协作已达到公开发言上限。',
  GROUP_DISCUSSION_MODEL_BUDGET_EXHAUSTED:
    '本次讨论已用完模型调用额度，请检查原任务后再继续。',
  GROUP_MEMBER_TOKEN_BUDGET_EXHAUSTED:
    '本次协作已达到用量额度，请核对结果后再继续。',
  GROUP_MEMBER_OWNER_BUDGET_EXHAUSTED:
    '你的近期协作已达到调用额度，请稍后继续。',
  GROUP_MEMBER_TOKEN_LIMIT_EXCEEDED:
    '模型报告的用量超过本次预留额度，协作已暂停，请核对原请求。',
  GROUP_MEMBER_MODEL_BACKPRESSURE: '待处理的协作请求已达到上限，请稍后再试。',
  GROUP_MEMBER_CAPACITY_WAIT_EXPIRED:
    '等待执行名额超时，协作已暂停，请核对后再继续。',
  GROUP_MEMBER_MODEL_CONTEXT_LIMIT:
    '这次协作的上下文超过用量上限，请缩小任务范围。',
  GROUP_MEMBER_NATIVE_INPUT_FAILED:
    '成员未能完成原消息，协作已中止，请检查模型和原任务。',
  GROUP_MEMBER_EFFECT_UNCERTAIN:
    '有工具的执行结果无法确认，协作已中止。请先核对原产物，避免重复执行。',
};
export function botGroupErrorMessage(code: unknown) {
  return typeof code === 'string' ? messages[code] : undefined;
}
