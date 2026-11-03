import { create } from 'zustand';
import { api } from '../api/client';

export type GoalStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'waiting_for_device'
  | 'completed'
  | 'failed'
  | 'cancelled';
export interface PersonalGoal {
  team?: {
    group_id: string;
    chief_profile_id: string;
    bot_member_ids: string[];
  };
  id: string;
  workspace_jid: string;
  session_id: string | null;
  objective: string;
  completion_criteria: string[];
  next_action: string;
  status: GoalStatus;
  budget_max_runs: number;
  budget_used_runs: number;
  revision: number;
  updated_at: string;
}
export const goalStatusLabels: Record<GoalStatus, string> = {
  pending: '待开始',
  running: '进行中',
  paused: '已暂停',
  waiting_for_input: '等待补充信息',
  waiting_for_approval: '等待审批',
  waiting_for_device: '等待设备',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};

export const useGoalsAvailability = create<{
  enabled: boolean;
  load: () => Promise<void>;
}>((set) => ({
  enabled: false,
  load: async () => {
    try {
      set(await api.get<{ enabled: boolean }>('/api/goals/availability'));
    } catch {
      set({ enabled: false });
    }
  },
}));
