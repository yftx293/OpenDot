import type { BotGroupSnapshot } from '../../../../src/bot-groups/types';
import type { DiscussionWorkView } from '../../../../src/bot-groups/discussion-types';

const capabilities: Record<string, string> = {
  read_workspace_file: '读取工作区文件',
  create_approved_artifact: '生成待确认产物',
  inspect_text: '检查文本',
};
const states: Record<DiscussionWorkView['state'], string> = {
  awaiting_approval: '等待主人确认',
  authorized: '后台工作已确认',
  denied: '已拒绝提议',
  cancelled: '讨论已停止，提议已取消',
  returned: '真实结果已返回群聊',
  failed: '工作未完成，请检查任务状态',
};
export function DiscussionWorkPanel({
  snapshot,
  verified,
  decide,
}: {
  snapshot: BotGroupSnapshot;
  verified: boolean;
  decide: (
    work: DiscussionWorkView,
    decision: 'approve' | 'deny',
  ) => Promise<unknown>;
}) {
  const work = snapshot.discussion?.work ?? [];
  if (!work.length) return null;
  const name = (id: string) =>
    snapshot.members.find(
      (member) => member.kind === 'bot' && member.subject_id === id,
    )?.display_name ?? 'Dot';
  return (
    <section aria-label="群聊后台工作" className="space-y-3 border-b px-4 py-4">
      <h3 className="text-sm font-medium">后台协作</h3>
      <p className="text-xs text-muted-foreground">
        确认后，工作在独立会话中执行，群聊可以继续。停止讨论会阻止后续接话；已确认的工作可在对应任务中单独停止。
      </p>
      {work.map((item) => (
        <article
          key={item.id}
          aria-label={`${name(item.requester_profile_id)} 的工作提议`}
          className="space-y-2 border-b py-3 last:border-b-0"
        >
          <p className="text-sm font-medium">
            {name(item.requester_profile_id)} → {name(item.target_profile_id)}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {item.instruction}
          </p>
          <p className="text-xs text-muted-foreground">
            {item.tool_capabilities.length
              ? item.tool_capabilities
                  .map((cap) => capabilities[cap] ?? cap)
                  .join('、')
              : '仅调用模型'}{' '}
            · 最多 {item.max_model_attempts} 次调用
          </p>
          <p className="text-sm" role="status">
            {states[item.state]}
          </p>
          {item.state === 'returned' && (
            <p className="text-xs text-muted-foreground">
              {item.continuation_state === 'consumed'
                ? '已安排请求方接续一次'
                : item.continuation_state === 'suppressed'
                  ? '结果已保留，本轮不再自动接话'
                  : '将在预算内让请求方接续一次'}
            </p>
          )}
          {item.can_decide && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="product-action min-h-11"
                disabled={!verified}
                onClick={() => void decide(item, 'approve')}
              >
                确认后台工作
              </button>
              <button
                type="button"
                className="min-h-11 rounded-lg border px-3 text-sm"
                disabled={!verified}
                onClick={() => void decide(item, 'deny')}
              >
                拒绝提议
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
