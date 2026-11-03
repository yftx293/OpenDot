/** Conversation-first status line. One sentence, no runtime ids. */

const TOOL_LABELS: Record<string, string> = {
  list_windows: '查看窗口',
  observe_window: '读取窗口',
  read_page: '读取页面',
  open_application: '打开应用',
  act_on_window: '操作窗口',
  capture_window: '截取窗口',
};

export function friendlyComputerTool(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const leaf = name.split('__').filter(Boolean).at(-1) ?? name;
  return TOOL_LABELS[leaf] ?? null;
}

export function durableStatusLine(input: {
  dotName: string;
  executionState?: string;
  busy?: boolean;
  retrying?: boolean;
  pendingApprovals?: number;
  currentTool?: string | null;
  partialText?: string;
}): string | null {
  const name = input.dotName.trim() || 'Dot';
  if (
    (input.pendingApprovals ?? 0) > 0 ||
    input.executionState === 'waiting_for_approval'
  )
    return `${name} · 等你确认`;
  if (input.executionState === 'recovering' || input.retrying)
    return `${name} · 正在恢复`;
  if (input.executionState === 'blocked') return `${name} · 需要核对`;
  if (input.executionState === 'failed' || input.executionState === 'suspended')
    return `${name} · 没有完成`;
  if (input.executionState === 'waiting_for_scheduler')
    return `${name} · 排队中`;
  if (input.executionState === 'cancelled') return null;
  const tool = friendlyComputerTool(input.currentTool);
  if (input.busy || input.executionState === 'active') {
    if (tool) return `${name} · 正在${tool}`;
    if (input.partialText?.trim()) return `${name} · 正在回复`;
    return `${name} · 正在处理`;
  }
  if (input.executionState === 'idle' || !input.executionState) return null;
  return `${name} · 正在处理`;
}

export function durableStatusNeedsAction(executionState?: string): boolean {
  return (
    executionState === 'failed' ||
    executionState === 'suspended' ||
    executionState === 'blocked'
  );
}

export function durableInputNeedsAction(input?: {
  state?: string;
  disposition?: string;
}): boolean {
  return input?.state === 'failed' || input?.disposition === 'failed';
}
