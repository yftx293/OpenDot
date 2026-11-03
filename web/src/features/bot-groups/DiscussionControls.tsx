import { buildDiscussionSettings } from './discussion-settings';
import { botGroupErrorMessage } from '../../../../src/bot-groups/errors';
import { useEffect, useState } from 'react';
import type { BotGroupSnapshot } from '../../../../src/bot-groups/types';

export function DiscussionSettingsForm({
  snapshot,
  verified,
  save,
}: {
  snapshot: BotGroupSnapshot;
  verified: boolean;
  save: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const settings = snapshot.discussion?.settings;
  const bots = snapshot.members.filter(
    (m) => m.kind === 'bot' && m.state === 'active' && m.available,
  );
  const initial = buildDiscussionSettings(snapshot);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [peerRelay, setPeerRelay] = useState(initial.policy === 'relay-v1');
  const [memberInbox, setMemberInbox] = useState(
    initial.execution_contract === 'member-inbox-v1',
  );
  const [coordinator, setCoordinator] = useState(
    initial.coordinator_profile_id,
  );
  const [participants, setParticipants] = useState<string[]>(
    initial.participant_profile_ids,
  );
  const [maxTurns, setMaxTurns] = useState(initial.max_turns);
  const [maxTurnsPerDot, setMaxTurnsPerDot] = useState(
    initial.max_turns_per_dot,
  );
  const saved = JSON.stringify(settings);
  const botIds = bots.map((m) => m.subject_id).join('|');
  useEffect(() => {
    const defaults = buildDiscussionSettings(snapshot);
    setEnabled(defaults.enabled);
    setPeerRelay(defaults.policy === 'relay-v1');
    setMemberInbox(defaults.execution_contract === 'member-inbox-v1');
    setCoordinator(defaults.coordinator_profile_id);
    setParticipants(defaults.participant_profile_ids);
    setMaxTurns(defaults.max_turns);
    setMaxTurnsPerDot(defaults.max_turns_per_dot);
    // Progress observations must not replace the user's unsaved selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, botIds]);
  const field =
    'min-h-11 min-w-0 max-w-full rounded-lg border bg-background px-3 text-sm';
  const memberLimit = snapshot.discussion?.member_inbox_max_participants ?? 2;
  return (
    <section aria-label="按轮讨论设置" className="space-y-3 border-b px-4 py-4">
      <h3 className="text-sm font-medium">
        {memberInbox ? '群内协作' : '按轮讨论'}
      </h3>
      <p className="text-sm text-muted-foreground">
        {memberInbox
          ? 'Dot 可以在工作时向另一位提问，并根据真实回复继续。公开发言仍受本次讨论额度限制。'
          : 'Dot 依次阅读群内公开发言，再补充或审查。'}
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save(
            buildDiscussionSettings(snapshot, {
              enabled,
              policy: peerRelay ? 'relay-v1' : 'coordinator-v1',
              coordinator_profile_id: coordinator,
              participant_profile_ids: participants,
              max_turns: maxTurns,
              max_turns_per_dot: maxTurnsPerDot,
              ...(snapshot.discussion?.member_inbox_available ||
              initial.execution_contract === 'member-inbox-v1'
                ? {
                    execution_contract: memberInbox
                      ? 'member-inbox-v1'
                      : 'serial-v1',
                  }
                : {}),
            }),
          );
        }}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label={memberInbox ? '开启群内协作' : '开启按轮讨论'}
            checked={enabled}
            disabled={!verified}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {memberInbox ? '开启群内协作' : '开启按轮讨论'}
        </label>
        <div>
          {(snapshot.discussion?.member_inbox_available ||
            initial.execution_contract === 'member-inbox-v1') && (
            <>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="边工作边互相提问"
                  checked={memberInbox}
                  disabled={
                    !verified ||
                    !enabled ||
                    (!snapshot.discussion?.member_inbox_available &&
                      !memberInbox)
                  }
                  onChange={(e) => setMemberInbox(e.target.checked)}
                />
                边工作边互相提问（实验）
              </label>
              <p className="text-xs text-muted-foreground">
                {memberLimit > 2
                  ? '选择两至八位在此服务器运行的 Dot'
                  : '选择两位本机 Dot'}
                ，可在各自工作时收发问题；只分享群内公开内容。从下一次讨论生效。
              </p>
            </>
          )}
          {!memberInbox && (
            <>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="允许 Dot 相互回应"
                  checked={peerRelay}
                  disabled={!verified || !enabled}
                  onChange={(event) => setPeerRelay(event.target.checked)}
                />
                允许 Dot 相互回应
              </label>
              <p className="text-xs text-muted-foreground">
                按成员顺序开始，Dot
                可以请其他成员接话。仍受轮次和调用预算限制，保存后从下一轮讨论生效。
              </p>
            </>
          )}
        </div>
        <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
          {memberInbox ? '先响应的 Dot' : '协调 Dot'}
          <select
            className={field}
            aria-label={memberInbox ? '先响应的 Dot' : '协调 Dot'}
            value={coordinator}
            disabled={!verified}
            onChange={(e) => setCoordinator(e.target.value)}
          >
            {bots.map((m) => (
              <option key={m.subject_id} value={m.subject_id}>
                {m.display_name}
              </option>
            ))}
          </select>
        </label>
        <fieldset disabled={!verified}>
          <legend className="mb-1 text-sm">参与讨论的 Dot</legend>
          {bots.map((m) => (
            <label
              key={m.subject_id}
              className="flex min-h-11 items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                aria-label={'参与讨论：' + m.display_name}
                checked={participants.includes(m.subject_id)}
                onChange={(e) =>
                  setParticipants((old) =>
                    e.target.checked
                      ? [...old, m.subject_id]
                      : old.filter((id) => id !== m.subject_id),
                  )
                }
              />
              {m.display_name}
            </label>
          ))}
        </fieldset>
        {memberInbox && (
          <p className="text-xs text-muted-foreground">
            {memberLimit > 2
              ? '请选择两至八位 Dot，并包含先响应的 Dot。'
              : '请选择两位 Dot，并包含先响应的 Dot。'}
          </p>
        )}
        <label className="flex items-center justify-between gap-2 text-sm">
          最多发言次数
          <select
            className={field}
            aria-label="最多发言次数"
            value={maxTurns}
            disabled={!verified}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
          >
            {[3, 6, 9, 12].map((n) => (
              <option key={n} value={n}>
                {n} 次
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-sm">
          每个 Dot 最多发言
          <select
            className={field}
            aria-label="每个 Dot 最多发言"
            value={maxTurnsPerDot}
            disabled={!verified}
            onChange={(e) => setMaxTurnsPerDot(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n} 次
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          使用各 Dot
          已配置的模型，开启即可讨论。文件和工具等额外能力可按需在高级设置中添加。
          {memberInbox || peerRelay
            ? '新讨论会优先响应你点名的参与成员。'
            : '讨论外 @ 单个 Dot 时按原有方式定向处理。'}
          讨论中可以继续补充要求。
        </p>
        <button
          className="product-action min-h-11"
          disabled={
            !verified ||
            !coordinator ||
            (enabled &&
              (!participants.length ||
                (memberInbox &&
                  (participants.length < 2 ||
                    participants.length > memberLimit ||
                    !participants.includes(coordinator)))))
          }
          type="submit"
        >
          保存讨论设置
        </button>
      </form>
    </section>
  );
}
export function DiscussionActivity({
  snapshot,
  verified,
  stop,
  stopMember,
  detailed = false,
}: {
  snapshot: BotGroupSnapshot;
  verified: boolean;
  stop: (runId: string) => void;
  stopMember?: (runId: string, profileId: string, leaseId: string) => void;
  detailed?: boolean;
}) {
  const run = snapshot.discussion?.run;
  if (!run) return null;
  // Older servers cannot prove native stop completion with status=cancelled.
  const stopState =
    run.stop_state ?? (run.status === 'cancelled' ? 'uncertain' : null);
  const name = (profileId: string) =>
    snapshot.members.find((m) => m.kind === 'bot' && m.subject_id === profileId)
      ?.display_name ?? 'Dot';
  const failure =
    botGroupErrorMessage(run.error_code) ??
    (run.error_code === 'GROUP_DISCUSSION_PROVIDER_FAILED'
      ? '模型服务暂时无法回复。请在设置中检查模型，恢复后再发送消息。'
      : null);
  const activity =
    stopState === 'stopping'
      ? '正在停止讨论…'
      : stopState === 'uncertain'
        ? '讨论已取消，停止尚未确认'
        : stopState === 'stopped'
          ? '讨论已停止'
          : (failure ??
            (detailed
              ? run.activity
              : run.status === 'running'
                ? '正在回复…'
                : run.status === 'waiting_user'
                  ? '需要你确认'
                  : '本次回复未完成，请查看群聊详情。'));
  const failed = run.status === 'failed' && !stopState;
  const stopLabel =
    stopState === 'uncertain'
      ? '重试停止'
      : stopState === 'stopping'
        ? '正在停止'
        : '停止讨论';
  const awaiting = snapshot.discussion?.awaiting ?? [];
  const pendingWork =
    snapshot.discussion?.work?.filter(
      (work) =>
        work.run_id === run.id &&
        ['awaiting_approval', 'authorized'].includes(work.state),
    ) ?? [];
  if (
    !detailed &&
    run.status === 'completed' &&
    !awaiting.length &&
    !pendingWork.length &&
    !stopState
  )
    return null;
  return (
    <>
      <div
        className={`flex min-h-11 items-center justify-between gap-2 px-3 ${
          failed
            ? 'text-sm leading-6 text-destructive'
            : 'text-xs text-muted-foreground'
        }`}
        aria-label="讨论进度"
      >
        <span role={failed ? 'alert' : 'status'} className="min-w-0">
          <span className="block">{activity}</span>
          {detailed && (
            <p>
              第 {run.round} 轮 · 已发言 {run.turn_count}/{run.max_turns} 次
            </p>
          )}
          {awaiting.length > 0 && (
            <span className="block" aria-label="等待确认的 Dot">
              {awaiting
                .map(
                  (item) =>
                    `${name(item.profile_id)} ${
                      item.reason === 'device' ? '等待设备结果' : '等待你的确认'
                    }`,
                )
                .join(' · ')}
            </span>
          )}
          {pendingWork.length > 0 && (
            <span className="block">
              {detailed
                ? `后台协作 ${pendingWork.length} 项`
                : pendingWork.some((work) => work.state === 'awaiting_approval')
                  ? '需要你确认后台工作'
                  : '后台工作正在处理'}
            </span>
          )}
        </span>
        {(run.status === 'running' ||
          stopState === 'stopping' ||
          stopState === 'uncertain') &&
          snapshot.membership.role === 'owner' && (
            <button
              type="button"
              className="min-h-11 shrink-0 px-3 text-foreground"
              aria-label={stopLabel}
              disabled={!verified || stopState === 'stopping'}
              onClick={() => stop(run.id)}
            >
              {stopLabel}
            </button>
          )}
      </div>
      {detailed &&
        stopMember &&
        !!snapshot.discussion?.member_tasks?.length && (
          <section className="px-3 pb-3" aria-label="本轮 Dot 回复">
            <p className="py-2 text-xs text-muted-foreground">
              可单独停止一位 Dot
              的本轮回复。其他成员和单独启动的后台工作会继续。
            </p>
            <ul className="divide-y divide-border">
              {snapshot.discussion.member_tasks.map((member) => {
                const state = {
                  active: '参与本轮',
                  completed: '本轮已结束',
                  stopping: '正在停止…',
                  stopped: '本轮回复已停止',
                  uncertain: '停止尚未确认',
                }[member.state];
                const label =
                  member.state === 'uncertain' ? '重试停止' : '停止回复';
                return (
                  <li
                    key={member.lease_id}
                    className="flex min-h-11 items-center justify-between gap-3 py-1"
                  >
                    <div className="min-w-0 text-sm">
                      <p className="truncate">{name(member.profile_id)}</p>
                      <p
                        className="text-xs text-muted-foreground"
                        role="status"
                      >
                        {state}
                      </p>
                    </div>
                    {member.can_stop && (
                      <button
                        type="button"
                        className="min-h-11 shrink-0 px-3 text-sm text-foreground"
                        aria-label={`${label}：${name(member.profile_id)}`}
                        disabled={!verified}
                        onClick={() =>
                          stopMember(run.id, member.profile_id, member.lease_id)
                        }
                      >
                        {label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
    </>
  );
}
