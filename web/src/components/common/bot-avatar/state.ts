import type { BotHandoffState } from '../../../../../src/bot-groups/handoff-types';
import type { GoalStatus } from '../../../stores/goals';
export type BotAvatarState =
  | 'idle'
  | 'working'
  | 'thinking'
  | 'waiting'
  | 'attention'
  | 'completed'
  | 'error';
export const avatarStateLabels: Record<BotAvatarState, string> = {
  idle: '常态',
  working: '正在工作',
  thinking: '正在思考',
  waiting: '正在等待',
  attention: '需要处理',
  completed: '已完成',
  error: '执行失败',
};
type Source =
  | { source: 'handoff'; status: BotHandoffState }
  | { source: 'goal'; status: GoalStatus }
  | { source: 'activity'; status: string }
  | { source: 'conversation'; executionState: string; busy: boolean }
  | { source: 'attention' };
/** Presentation only. Callers supply an authorized current server snapshot, never connection state. */
export function avatarState(input: Source | null | undefined): BotAvatarState {
  if (!input) return 'idle';
  if (input.source === 'attention') return 'attention';
  if (input.source === 'conversation') {
    if (input.executionState === 'active')
      return input.busy ? 'working' : 'idle';
    if (
      [
        'waiting_for_input',
        'waiting_for_approval',
        'waiting_for_receipt',
        'blocked',
      ].includes(input.executionState)
    )
      return 'attention';
    if (input.executionState === 'completed') return 'completed';
    if (
      [
        'cancelled',
        'suspended',
        'recovering',
        'paused',
        'waiting_for_scheduler',
        'waiting_for_device',
      ].includes(input.executionState)
    )
      return 'waiting';
    if (input.executionState === 'failed') return 'error';
    return 'idle';
  }
  const status: string = input.status;
  if (status === 'running') return 'working';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'error';
  if (
    [
      'waiting_for_authorization',
      'waiting_for_approval',
      'waiting_for_input',
      'uncertain',
    ].includes(status)
  )
    return 'attention';
  if (
    [
      'pending',
      'waiting_for_device',
      'paused',
      'cancelling',
      'cancelled',
    ].includes(status)
  )
    return 'waiting';
  return 'idle';
}
