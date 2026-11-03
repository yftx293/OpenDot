import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { api } from '../../api/client';
import { BotAvatar } from '../../components/common/BotAvatar';
import { useAuthStore } from '../../stores/auth';
import { getAgentProfileDisplayName } from '../../utils/agent-product';
import { useGroupCommand } from './useBotGroup';

type DotChoice = {
  id: string;
  name: string;
  is_default: number | boolean;
  avatar_emoji?: string | null;
  avatar_color?: string | null;
  avatar_shape?: string | null;
  avatar_url?: string | null;
};

/** Shared by the conversation drawer and the group page. One command commits
 * the whole roster, retaining the same receipt across a lost response/reload. */
export function CreateBotGroupForm({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const actor = useAuthStore((s) => s.user?.id);
  const navigate = useNavigate();
  const command = useGroupCommand('create');
  const helpId = useId();
  const [choices, setChoices] = useState<DotChoice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [hasWorkspace, setHasWorkspace] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setEnabled(false);
    setChoices([]);
    setSelected([]);
    setSearch('');
    setHasWorkspace(false);
    setName('');
    Promise.all([
      api.get<{ enabled: boolean }>('/api/bot-groups/availability'),
      api.get<{
        profiles: DotChoice[];
        workspaces: { jid: string }[];
      }>('/api/bot-groups/options'),
    ])
      .then(([availability, options]) => {
        if (!alive || useAuthStore.getState().user?.id !== actor) return;
        setEnabled(availability.enabled);
        setChoices(options.profiles);
        setSelected(
          options.profiles.filter((dot) => dot.is_default).map((dot) => dot.id),
        );
        setHasWorkspace(options.workspaces.length > 0);
        setError('');
      })
      .catch(() => {
        if (alive) setError('无法读取可邀请的 Dot，请重新打开后重试。');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [actor]);
  useEffect(() => {
    if (loading || !command.pending) return;
    const body = command.pending.body;
    if (typeof body.name === 'string') setName(body.name);
    if (
      Array.isArray(body.bot_profile_ids) &&
      body.bot_profile_ids.every((id) => typeof id === 'string')
    )
      setSelected(body.bot_profile_ids as string[]);
  }, [loading, command.pending]);
  useEffect(() => {
    onBusyChange?.(command.busy);
    return () => onBusyChange?.(false);
  }, [command.busy, onBusyChange]);
  const finish = (reply: Awaited<ReturnType<typeof command.submit>>) => {
    if (reply)
      navigate('/bot-groups/' + encodeURIComponent(reply.receipt.group_id));
  };
  const control =
    'mt-1 block min-h-11 w-full rounded-lg border bg-background px-3 text-base';
  const visible = choices.filter((dot) =>
    getAgentProfileDisplayName(dot.name)
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <form
      aria-label="新建群聊"
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          !enabled ||
          loading ||
          !hasWorkspace ||
          !name.trim() ||
          !selected.length
        )
          return;
        finish(
          await command.submit('/api/bot-groups', 'POST', {
            name: name.trim(),
            bot_profile_ids: [...selected].sort(),
          }),
        );
      }}
    >
      <label className="block text-sm">
        群聊名称
        <input
          autoFocus
          className={control}
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!!command.pending || loading}
          placeholder="例如：产品小队"
        />
      </label>
      <fieldset
        disabled={!!command.pending || loading}
        aria-describedby={helpId}
        className="min-w-0"
      >
        <legend className="text-sm font-medium">邀请 Dot</legend>
        <p id={helpId} className="mt-1 text-sm text-muted-foreground">
          可多选，一起加入这个群聊。之后仍可添加或移除。
        </p>
        {choices.length > 5 && (
          <label className="relative mt-3 block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-3 size-5 text-muted-foreground"
            />
            <input
              aria-label="搜索可邀请的 Dot"
              className={control + ' pl-10'}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索 Dot"
            />
          </label>
        )}
        <div className="mt-3 max-h-64 overflow-y-auto overscroll-contain">
          {visible.map((dot) => (
            <label
              key={dot.id}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:checked]:bg-accent/10"
            >
              <BotAvatar
                botId={dot.id}
                name={dot.name}
                imageUrl={dot.avatar_url}
                emoji={dot.avatar_emoji}
                color={dot.avatar_color}
                shape={dot.avatar_shape}
                size="md"
                decorative
              />
              <span className="min-w-0 flex-1 break-words text-sm">
                {getAgentProfileDisplayName(dot.name)}
              </span>
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-primary"
                checked={selected.includes(dot.id)}
                disabled={!selected.includes(dot.id) && selected.length >= 49}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, dot.id]
                      : current.filter((id) => id !== dot.id),
                  )
                }
              />
            </label>
          ))}
          {!loading && choices.length > 0 && visible.length === 0 && (
            <p className="py-3 text-sm text-muted-foreground">
              没有找到匹配的 Dot。
            </p>
          )}
        </div>
        {!loading && choices.length > 0 && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            已选择 {selected.length} 个 Dot
            {selected.length === 0
              ? '，请至少选择一个。'
              : selected.length === 49
                ? '（已达上限）'
                : ''}
          </p>
        )}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Dot 默认可阅读群内消息并回复；文件和工具等额外能力之后再设置。
      </p>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取可邀请的 Dot…
        </p>
      )}
      {!loading && !error && !enabled && (
        <p role="status" className="text-sm text-muted-foreground">
          新群聊暂未开放，已有群聊仍可查看。
        </p>
      )}
      {!loading &&
        !error &&
        enabled &&
        (!hasWorkspace || choices.length === 0) && (
          <Link
            to="/bots?create=1"
            className="block min-h-11 py-3 text-sm underline"
          >
            先新建一个 Dot，再创建群聊
          </Link>
        )}
      {command.pending &&
        selected.some((id) => !choices.some((dot) => dot.id === id)) && (
          <p role="status" className="text-sm text-muted-foreground">
            部分已选 Dot 当前不可用；待确认操作仍保留原来的选择。
          </p>
        )}
      {(error || command.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || command.error}
        </p>
      )}
      <div className="sticky bottom-0 bg-background py-3">
        <button
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50"
          type={command.pending ? 'button' : 'submit'}
          disabled={
            !enabled ||
            loading ||
            !!error ||
            command.busy ||
            (!command.pending &&
              (!name.trim() || !hasWorkspace || !selected.length))
          }
          onClick={
            command.pending
              ? async () => finish(await command.retry())
              : undefined
          }
        >
          <Plus className="size-5" aria-hidden="true" />
          {command.busy
            ? '正在创建…'
            : command.pending
              ? '使用原标识重试创建'
              : '创建群聊'}
        </button>
      </div>
    </form>
  );
}
