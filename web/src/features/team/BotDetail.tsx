import { useEffect, useState } from 'react';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { Input } from '../../components/ui/input';
import { Link } from 'react-router-dom';
import type { AgentProfile } from '../../types';
import type { TeamOverview } from '../../../../src/personal-agent/team-product-types';
import { BotIdentityAvatar } from '../../components/common/BotIdentityAvatar';
import type { BotAvatarState } from '../../components/common/BotAvatar';
import { profileIdentity } from '../../components/common/bot-avatar/product-state';

export const botStateLabels: Record<string, string> = {
  pending: '排队中',
  running: '正在工作',
  waiting_for_approval: '等待批准',
  waiting_for_device: '等待你的设备',
  paused: '已暂停',
  completed: '已交付',
  failed: '需要处理',
  uncertain: '回执待核对',
  cancelled: '已取消',
};
export function BotDetail({
  profile,
  avatarState = 'idle',
  activity,
  model,
  pending,
  onChat,
  verified,
  nativeWork,
}: {
  profile: AgentProfile;
  avatarState?: BotAvatarState;
  activity?: TeamOverview['activity'][string];
  model: string;
  pending: boolean;
  verified: boolean;
  nativeWork?: { text?: string; last_active?: string };
  onChat: () => void;
}) {
  const [tab, setTab] = useState('conversation');
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const updateProfile = useAgentProfilesStore((s) => s.updateProfile);
  useEffect(() => {
    setName(profile.name);
  }, [profile.id, profile.name]);
  useEffect(() => {
    setNameError('');
  }, [profile.id]);
  const tabs = [
    ['conversation', '对话'],
    ['work', '当前工作'],
    ['capabilities', '能力'],
    ['memory', '记忆'],
    ['settings', '设置'],
  ];
  const policy = profile.effective_runtime_policy ?? profile.runtime_policy;
  return (
    <div className="space-y-5" aria-label="Dot 详情">
      <div className="flex items-center gap-3">
        <BotIdentityAvatar
          bot={profileIdentity(profile)}
          state={avatarState}
          size="lg"
        />
        <div>
          <p className="font-medium">{profile.name}</p>
          <p className="text-xs text-muted-foreground">
            {profile.is_default ? '你的个人协调员' : '个人团队成员'}
          </p>
        </div>
      </div>
      <div role="tablist" aria-label="Dot 详情栏目" className="bot-detail-tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            onKeyDown={(event) => {
              const index = tabs.findIndex((item) => item[0] === tab);
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                setTab(tabs[next][0]);
                document
                  .getElementById('bot-tab-' + profile.id + '-' + tabs[next][0])
                  ?.focus();
              }
            }}
            aria-controls={'bot-panel-' + profile.id + '-' + id}
            id={'bot-tab-' + profile.id + '-' + id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={'bot-panel-' + profile.id + '-' + tab}
        aria-labelledby={'bot-tab-' + profile.id + '-' + tab}
        className="space-y-4 text-sm"
      >
        {tab === 'conversation' && (
          <>
            <p className="text-muted-foreground">继续与这个 Bot 的原有对话。</p>
            <button
              type="button"
              disabled={pending}
              onClick={onChat}
              className="product-action"
            >
              {pending ? '正在核对入口…' : '开始对话'}
            </button>
          </>
        )}
        {tab === 'work' && (
          <>
            <p role="status">
              {nativeWork
                ? '正在对话'
                : activity
                  ? (botStateLabels[activity.status] ?? '正在核对状态')
                  : verified
                    ? '暂无团队任务'
                    : '团队动态待核对'}
            </p>
            {nativeWork?.text && <p>{nativeWork.text}</p>}
            {nativeWork?.last_active && (
              <p className="product-metadata">
                最近对话：{new Date(nativeWork.last_active).toLocaleString()}
              </p>
            )}
            {activity && (
              <>
                <p>{activity.task}</p>
                <p className="product-metadata">
                  最近活动：{new Date(activity.last_active).toLocaleString()}
                </p>
                {activity.goal_id && (
                  <Link
                    to={'/goals?goal=' + activity.goal_id}
                    className="product-action-secondary"
                  >
                    查看目标与成果
                  </Link>
                )}
              </>
            )}
          </>
        )}
        {tab === 'capabilities' && (
          <>
            <p>模型：{model}</p>
            <p>
              技能：
              {policy.skills.mode === 'disabled'
                ? '未启用'
                : policy.skills.mode === 'custom'
                  ? `已配置 ${policy.skills.ids.length} 项`
                  : '使用默认配置'}
            </p>
            <p>
              外部连接：
              {policy.mcp.mode === 'disabled'
                ? '未启用'
                : policy.mcp.mode === 'custom'
                  ? `已配置 ${policy.mcp.ids.length} 项`
                  : '使用默认配置'}
            </p>
            <p className="text-xs text-muted-foreground">
              实际执行按当前任务授权核对。配置不会自动授予设备或工作区权限。
            </p>
          </>
        )}
        {tab === 'memory' && (
          <>
            <p className="text-muted-foreground">
              记忆保留原有工作区与个人授权范围。
            </p>
            <Link to="/memory" className="product-action-secondary">
              查看已授权的记忆
            </Link>
          </>
        )}
        {tab === 'settings' && (
          <>
            <form
              className="space-y-3"
              onSubmit={async (event) => {
                event.preventDefault();
                if (saving || !name.trim()) return;
                setSaving(true);
                setNameError('');
                try {
                  await updateProfile(profile.id, { name: name.trim() });
                } catch (error) {
                  setNameError(
                    error instanceof Error
                      ? error.message
                      : '名称未保存，请重试。',
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              <label className="block space-y-2">
                <span>Dot 名称</span>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  required
                  disabled={saving}
                />
              </label>
              <button
                className="product-action"
                disabled={
                  saving || !name.trim() || name.trim() === profile.name
                }
              >
                {saving ? '正在保存…' : '保存名称'}
              </button>
              {nameError && <p role="alert">{nameError}</p>}
            </form>
            <p className="text-muted-foreground">
              模型与能力在高级设置中管理。
            </p>
            <Link
              to={'/agent-profiles?agent=' + encodeURIComponent(profile.id)}
              className="product-action-secondary"
            >
              配置 Dot
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
