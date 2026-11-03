import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock3, MessageCircle, Plus, Search, Users } from 'lucide-react';
import { api } from '../../api/client';
import { wsManager } from '../../api/ws';
import type { BotGroup } from '../../../../src/bot-groups/types';
import { useAuthStore } from '../../stores/auth';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { useChatStore } from '../../stores/chat';
import { BotIdentityAvatar } from '../common/BotIdentityAvatar';
import { profileIdentity } from '../common/bot-avatar/product-state';
import { chooseBotWorkspace } from '../../utils/bot-entry';
import { getAgentProfileDisplayName } from '../../utils/agent-product';
import { compareByLastActivity } from '../../utils/group-utils';
import { getPresentedMessageContent } from '../../lib/message-presentation';

function preview(content?: string) {
  return content
    ? getPresentedMessageContent({
        content,
        source_kind: null,
        finalization_reason: null,
      })
        .replace(/\s+/g, ' ')
        .trim()
    : '还没有消息';
}

/** One place to find identities and their existing conversations. Entry authority
 * still comes from BotsPage's fresh server receipt, never from this list hint. */
export function ConversationPicker({
  onCreate,
  onCreateGroup,
  onVisit,
}: {
  onCreate: () => void;
  onCreateGroup: () => void;
  onVisit: () => void;
}) {
  const owner = useAuthStore((s) => s.user?.id);
  const profiles = useAgentProfilesStore((s) => s.profiles);
  const profilesError = useAgentProfilesStore((s) => s.profilesError);
  const loadProfiles = useAgentProfilesStore((s) => s.loadProfiles);
  const groups = useChatStore((s) => s.groups);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const [search, setSearch] = useState('');
  const [teams, setTeams] = useState<{ owner?: string; items: BotGroup[] }>({
    items: [],
  });
  const [teamsError, setTeamsError] = useState('');
  useEffect(() => {
    let alive = true,
      version = 0;
    const load = async () => {
      const ticket = ++version;
      try {
        const reply = await api.get<{ groups: BotGroup[] }>('/api/bot-groups');
        if (
          !alive ||
          ticket !== version ||
          useAuthStore.getState().user?.id !== owner
        )
          return;
        setTeams({ owner, items: reply.groups });
        setTeamsError('');
      } catch {
        if (alive && ticket === version)
          setTeamsError('无法读取群聊，请重新打开后重试。');
      }
    };
    setTeams({ owner, items: [] });
    setTeamsError('');
    void load();
    const stops = [
      'connected',
      'bot_group_update',
      'bot_group_access_revoked',
    ].map((event) => wsManager.on(event, () => void load()));
    return () => {
      alive = false;
      stops.forEach((stop) => stop());
    };
  }, [owner]);
  useEffect(() => {
    void loadProfiles();
    void loadGroups();
  }, [owner, loadProfiles, loadGroups]);
  const dots = useMemo(
    () =>
      profiles
        .filter(
          (profile) =>
            profile.owner_user_id === owner && profile.status === 'active',
        )
        .map((profile) => ({
          profile,
          destination: chooseBotWorkspace(profile, groups),
        }))
        .sort(
          (a, b) =>
            Number(b.profile.is_default) - Number(a.profile.is_default) ||
            (b.destination?.group.lastMessageTime || '').localeCompare(
              a.destination?.group.lastMessageTime || '',
            ),
        ),
    [profiles, owner, groups],
  );
  const mainJids = new Set(
    dots.flatMap((dot) => (dot.destination ? [dot.destination.jid] : [])),
  );
  const others = Object.entries(groups)
    .map(([jid, group]) => ({ ...group, jid }))
    .filter((group) => !mainJids.has(group.jid))
    .sort(compareByLastActivity);
  const matches = (name: string, message?: string) =>
    (name + ' ' + preview(message))
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  const visibleDots = dots.filter(({ profile, destination }) =>
    matches(profile.name, destination?.group.lastMessage),
  );
  const visibleOthers = others.filter((group) =>
    matches(group.name, group.lastMessage),
  );
  const visibleTeams =
    teams.owner === owner
      ? teams.items.filter((group) => matches(group.name))
      : [];
  return (
    <div className="row-span-2 flex min-h-0 flex-col">
      <div className="space-y-3 px-4 py-4">
        <button
          type="button"
          onClick={onCreate}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          <Plus className="size-5" aria-hidden="true" /> 新建 Dot
        </button>
        <button
          type="button"
          onClick={onCreateGroup}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium hover:bg-muted"
        >
          <Plus className="size-5" aria-hidden="true" /> 新建群聊
        </button>
        <label className="flex min-h-11 items-center gap-2 rounded-xl border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <span className="sr-only">搜索 Dot 和对话</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 Dot 和对话"
            className="min-w-0 flex-1 bg-transparent text-base outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-5">
        {profilesError && (
          <p role="alert" className="px-2 text-sm text-destructive">
            {profilesError}
          </p>
        )}
        <section aria-label="我的 Dot">
          <h3 className="px-2 pb-2 text-xs font-medium text-muted-foreground">
            我的 Dot
          </h3>
          {visibleDots.map(({ profile, destination }) => {
            const name = getAgentProfileDisplayName(profile.name);
            const entry = '/bots?profile=' + encodeURIComponent(profile.id);
            return (
              <div
                key={profile.id}
                className="flex items-center rounded-xl hover:bg-muted"
              >
                <Link
                  to={entry}
                  onClick={onVisit}
                  className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <BotIdentityAvatar bot={profileIdentity(profile)} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {destination
                        ? preview(destination.group.lastMessage)
                        : '开始第一段对话'}
                    </span>
                  </span>
                </Link>
                {destination && (
                  <Link
                    to={entry + '&history=1'}
                    onClick={onVisit}
                    aria-label={name + '的历史对话'}
                    className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Clock3 className="size-4" />
                  </Link>
                )}
              </div>
            );
          })}
          {!dots.length && !profilesError && (
            <p className="px-2 text-sm text-muted-foreground">
              还没有 Dot，先新建一个吧。
            </p>
          )}
        </section>
        <section aria-label="我的群聊">
          <h3 className="px-2 pb-2 text-xs font-medium text-muted-foreground">
            群聊
          </h3>
          {teamsError && (
            <p role="alert" className="px-2 text-sm text-destructive">
              {teamsError}
            </p>
          )}
          {visibleTeams.map((group) => (
            <Link
              key={group.id}
              to={'/bot-groups/' + encodeURIComponent(group.id)}
              onClick={onVisit}
              className="flex min-h-16 items-center gap-3 rounded-xl px-2 py-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Users className="size-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {group.name}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {group.message_count} 条消息
                  {group.state === 'archived' ? ' · 已归档' : ''}
                </span>
              </span>
            </Link>
          ))}
          {!search.trim() && !visibleTeams.length && !teamsError && (
            <p className="px-2 text-sm text-muted-foreground">
              还没有群聊，点击上方「新建群聊」。
            </p>
          )}
        </section>
        {visibleOthers.length > 0 && (
          <section aria-label="其他对话">
            <h3 className="px-2 pb-2 text-xs font-medium text-muted-foreground">
              其他对话
            </h3>
            {visibleOthers.map((group) => (
              <div
                key={group.jid}
                className="flex items-center rounded-xl hover:bg-muted"
              >
                <Link
                  to={'/chat/' + encodeURIComponent(group.folder)}
                  onClick={onVisit}
                  className="flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MessageCircle className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {group.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {preview(group.lastMessage)}
                    </span>
                  </span>
                </Link>
                <Link
                  to={
                    '/chat/' + encodeURIComponent(group.folder) + '?sessions=1'
                  }
                  onClick={onVisit}
                  aria-label={group.name + '的历史对话'}
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Clock3 className="size-4" />
                </Link>
              </div>
            ))}
          </section>
        )}
        {search.trim() &&
          !visibleDots.length &&
          !visibleOthers.length &&
          !visibleTeams.length && (
            <p
              role="status"
              className="px-2 py-6 text-sm text-muted-foreground"
            >
              没有找到匹配的 Dot 或对话。
            </p>
          )}
      </div>
    </div>
  );
}
