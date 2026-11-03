import { TeamHome } from '../features/team/TeamHome';
import type { TeamOverview } from '../../../src/personal-agent/team-product-types';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, ArrowRight } from 'lucide-react';
import { BotDetail, botStateLabels } from '../features/team/BotDetail';
import { BotIdentityAvatar } from '../components/common/BotIdentityAvatar';
import {
  activityAvatarState,
  profileIdentity,
  mainWorkspaceForBot,
} from '../components/common/bot-avatar/product-state';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useProductContext } from '../components/layout/ContextPanel';
import { useAgentProfilesStore } from '../stores/agent-profiles';
import { useChatStore } from '../stores/chat';
import { getAgentProfileDisplayName } from '../utils/agent-product';
import type { AgentProfile } from '../types';
import { chooseBotWorkspace } from '../utils/bot-entry';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { CreateContainerDialog } from '../components/chat/CreateContainerDialog';

export { chooseBotWorkspace } from '../utils/bot-entry';

export function BotsPage() {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const teamView = query.get('view') === 'team';
  const historyRequested = query.get('history') === '1';
  const context = useProductContext();
  const home = useRef<HTMLElement>(null);
  const [activity, setActivity] = useState<TeamOverview['activity']>({});
  const [activityKnown, setActivityKnown] = useState(false);
  const updateActivity = useCallback(
    (value: TeamOverview['activity'], verified = false) => {
      setActivity(value);
      setActivityKnown(verified);
    },
    [],
  );
  const profiles = useAgentProfilesStore((s) => s.profiles);
  const modelConfigs = useAgentProfilesStore((s) => s.modelConfigs);
  const defaultModelConfigId = useAgentProfilesStore(
    (s) => s.defaultModelConfigId,
  );
  const loading = useAgentProfilesStore((s) => s.loading);
  const profilesError = useAgentProfilesStore((s) => s.profilesError);
  const loadProfiles = useAgentProfilesStore((s) => s.loadProfiles);
  const groups = useChatStore((s) => s.groups);
  const activeRuns = useChatStore((s) => s.activeRuns);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const owner = useAuthStore((s) => s.user?.id);
  const connection = useConnectionStatus();
  useLayoutEffect(() => {
    home.current
      ?.closest<HTMLElement>('[data-app-scroll-root]')
      ?.scrollTo({ top: 0 });
  }, [owner]);
  const request = useRef(0);
  const attemptedEntry = useRef('');
  const [opening, setOpening] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState<AgentProfile | null>(
    null,
  );

  useEffect(() => {
    void loadProfiles();
    void loadGroups();
    setEntryError(null);
    setOpening(null);
    setCreatingProfile(null);
    return () => {
      request.current++;
      attemptedEntry.current = '';
    };
  }, [owner, loadProfiles, loadGroups]);

  const sorted = useMemo(
    () =>
      profiles
        .filter((profile) => profile.owner_user_id === owner)
        .sort((a, b) => Number(b.is_default) - Number(a.is_default)),
    [profiles, owner],
  );

  const openBot = useCallback(
    async (profile: AgentProfile, preferredJid?: string): Promise<boolean> => {
      const ticket = ++request.current;
      const current = () =>
        request.current === ticket &&
        useAuthStore.getState().user?.id === owner;
      setOpening(profile.id);
      setEntryError(null);
      try {
        const result = await api.get<{
          destination: null | {
            owner_user_id: string;
            workspace_jid: string;
            folder: string;
            profile_id: string;
            session_kind: string;
          };
        }>(
          `/api/agent-profiles/${encodeURIComponent(profile.id)}/chat-entry${preferredJid ? '?workspace_jid=' + encodeURIComponent(preferredJid) : ''}`,
        );
        if (!current()) return false;
        const destination = result.destination;
        if (!destination) {
          if (profile.is_default || preferredJid)
            setEntryError('当前 Bot 没有可用会话，请核对工作区权限与配置。');
          else setCreatingProfile(profile);
          return false;
        }
        await loadGroups();
        if (!current()) return false;
        const group = useChatStore.getState().groups[destination.workspace_jid];
        if (
          destination.session_kind !== 'workspace_main' ||
          destination.owner_user_id !== owner ||
          destination.profile_id !== profile.id ||
          group?.folder !== destination.folder ||
          group.agent_profile_id !== profile.id
        )
          throw new Error('Stale destination');
        selectGroup(destination.workspace_jid);
        navigate(
          '/chat/' +
            encodeURIComponent(destination.folder) +
            '?bot=' +
            encodeURIComponent(profile.id) +
            (historyRequested ? '&sessions=1' : ''),
          // /bots is an authority-checked entry resolver outside the team view.
          // Keeping it in history traps Back in an immediate redirect to chat.
          { replace: !teamView },
        );
        return true;
      } catch {
        if (current())
          setEntryError('入口或网络状态已变化。请刷新，或打开原对话核对。');
      } finally {
        if (current()) setOpening(null);
      }
      return false;
    },
    [owner, loadGroups, selectGroup, navigate, historyRequested, teamView],
  );

  const chief = sorted.find(
    (profile) => profile.is_default && profile.status === 'active',
  );
  const modelFor = (profile: AgentProfile) =>
    modelConfigs.find(
      (model) => model.id === (profile.model_config_id ?? defaultModelConfigId),
    )?.anthropic_model ?? '默认模型';
  function nativeWorkFor(profile: AgentProfile) {
    const task = activity[profile.id];
    if (
      task &&
      [
        'pending',
        'running',
        'waiting_for_approval',
        'waiting_for_device',
        'paused',
        'uncertain',
      ].includes(task.status)
    )
      return undefined;
    const workspace = mainWorkspaceForBot(profile.id, groups, activeRuns);
    return workspace
      ? {
          text: workspace[1].lastMessage,
          last_active: workspace[1].lastMessageTime,
        }
      : undefined;
  }
  function avatarFor(profile: AgentProfile) {
    return activityAvatarState(
      nativeWorkFor(profile) ? 'running' : activity[profile.id]?.status,
      activityKnown && connection === 'connected',
      profile.status === 'archived',
    );
  }
  const selectedProfile = context.content?.key.startsWith('bot:')
    ? sorted.find((profile) => 'bot:' + profile.id === context.content?.key)
    : undefined;
  useEffect(() => {
    if (!selectedProfile) return;
    context.update(
      'bot:' + selectedProfile.id,
      <BotDetail
        profile={selectedProfile}
        avatarState={avatarFor(selectedProfile)}
        verified={activityKnown}
        activity={activity[selectedProfile.id]}
        nativeWork={nativeWorkFor(selectedProfile)}
        model={modelFor(selectedProfile)}
        pending={opening !== null}
        onChat={() => {
          context.close();
          void openBot(selectedProfile);
        }}
      />,
    );
  }, [
    selectedProfile,
    activity,
    activityKnown,
    connection,
    activeRuns,
    groups,
    modelConfigs,
    defaultModelConfigId,
    opening,
    openBot,
    context.update,
    context.close,
  ]);
  function inspect(profile: AgentProfile) {
    context.open({
      key: 'bot:' + profile.id,
      title: getAgentProfileDisplayName(profile.name),
      description: '对话、当前工作与已配置能力。',
      body: (
        <BotDetail
          profile={profile}
          avatarState={avatarFor(profile)}
          verified={activityKnown}
          activity={activity[profile.id]}
          nativeWork={nativeWorkFor(profile)}
          model={modelFor(profile)}
          pending={opening !== null}
          onChat={() => {
            context.close();
            void openBot(profile);
          }}
        />
      ),
    });
  }
  const requestedProfile = query.get('profile');
  const entryTarget = requestedProfile
    ? sorted.find(
        (profile) =>
          profile.id === requestedProfile && profile.status === 'active',
      )
    : chief;
  useEffect(() => {
    if (teamView || !entryTarget) return;
    const key = `${owner}:${entryTarget.id}:${historyRequested}`;
    if (attemptedEntry.current === key) return;
    attemptedEntry.current = key;
    void openBot(entryTarget);
  }, [teamView, owner, entryTarget?.id, historyRequested, openBot]);
  if (!teamView)
    return (
      <main className="chief-entry" aria-label="Dot 对话入口">
        <p role={entryError || profilesError ? 'alert' : 'status'}>
          {entryError ||
            profilesError ||
            (loading || opening
              ? '正在打开你的对话…'
              : '没有可用对话。请在团队中核对 Bot 与授权。')}
        </p>
        {(entryError || profilesError) && (
          <button
            className="product-action-secondary"
            onClick={() =>
              entryTarget ? void openBot(entryTarget) : void loadProfiles()
            }
          >
            重试
          </button>
        )}
        <Link className="product-action-secondary" to="/bots?view=team">
          查看团队
        </Link>
        <CreateContainerDialog
          open={!!creatingProfile}
          onClose={() => setCreatingProfile(null)}
          initialAgentProfileId={creatingProfile?.id}
          onCreated={(jid) => {
            if (creatingProfile) void openBot(creatingProfile, jid);
            setCreatingProfile(null);
          }}
        />
      </main>
    );
  return (
    <main ref={home} className="chief-page" aria-label="我的 Dot">
      {teamView ? (
        <header className="team-page-heading">
          <div>
            <p className="product-metadata">MY TEAM</p>
            <h1 className="product-page-title">我的 Dot</h1>
          </div>
          <Link
            to="/agent-profiles?create=1"
            className="product-action-secondary"
          >
            <Plus size={16} />
            创建 Bot
          </Link>
        </header>
      ) : null}

      {teamView && (
        <nav aria-label="团队栏目" className="team-switcher">
          <Link to="/bots?view=team" aria-current="page">
            Bots
          </Link>
          <Link to="/bot-groups">群聊</Link>
        </nav>
      )}
      {owner && (
        <TeamHome
          key={owner}
          ownerId={owner}
          onActivity={updateActivity}
          showWork={!teamView}
        />
      )}
      {entryError && (
        <p role="alert" className="text-sm text-destructive">
          {entryError}
        </p>
      )}
      <section aria-labelledby="bots-heading" className="space-y-2">
        {!teamView && (
          <div className="flex items-center justify-between">
            <h2 id="bots-heading" className="product-section-title">
              我的 Dot
            </h2>
            <Link
              to="/agent-profiles?create=1"
              className="inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground"
            >
              <Plus size={14} />
              创建 Bot
            </Link>
            <Link
              to="/bots?view=team"
              className="inline-flex min-h-11 items-center text-xs text-muted-foreground"
            >
              查看团队 <ArrowRight size={14} />
            </Link>
          </div>
        )}
        {teamView && (
          <h2 id="bots-heading" className="sr-only">
            团队成员
          </h2>
        )}
        {profilesError && (
          <p role="alert" className="text-sm text-destructive">
            {profilesError}
          </p>
        )}
        {loading && !profiles.length && (
          <div
            role="status"
            className="py-6 text-sm text-muted-foreground motion-safe:animate-pulse"
          >
            正在连接你的团队…
          </div>
        )}
        <div className="bot-contact-list">
          {sorted.map((profile) => {
            const nativeWork = nativeWorkFor(profile);
            const target = chooseBotWorkspace(profile, groups),
              state = activity[profile.id],
              name = getAgentProfileDisplayName(profile.name),
              policy =
                profile.effective_runtime_policy ?? profile.runtime_policy;
            return (
              <article key={profile.id} className="bot-contact-row">
                <BotIdentityAvatar
                  bot={profileIdentity(profile)}
                  state={avatarFor(profile)}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <h3>
                    <button
                      type="button"
                      onClick={() => inspect(profile)}
                      className="min-h-11 text-left font-medium"
                    >
                      {name}
                    </button>
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {profile.is_default ? '你的个人协调员' : '个人团队成员'} ·{' '}
                    {modelFor(profile)}
                  </p>
                  {(state || nativeWork?.text) && (
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {nativeWork?.text ?? state?.task}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {policy.skills.mode === 'disabled'
                      ? '未启用技能'
                      : '技能已配置'}{' '}
                    ·{' '}
                    {policy.mcp.mode === 'disabled'
                      ? '未启用外部连接'
                      : '外部连接已配置'}
                    {state
                      ? ' · ' + new Date(state.last_active).toLocaleString()
                      : target?.group.lastMessageTime
                        ? ' · 最近对话 ' +
                          new Date(
                            target.group.lastMessageTime,
                          ).toLocaleString()
                        : ''}
                  </p>
                </div>
                <div className="bot-contact-actions">
                  <span role="status" className="text-xs text-muted-foreground">
                    {profile.status === 'archived'
                      ? '已归档'
                      : nativeWork
                        ? '正在对话'
                        : state
                          ? (botStateLabels[state.status] ?? '核对状态中')
                          : activityKnown
                            ? '暂无团队任务'
                            : '团队动态待核对'}
                  </span>
                  <button
                    type="button"
                    className="min-h-11 text-xs"
                    disabled={opening !== null || profile.status === 'archived'}
                    onClick={() => void openBot(profile)}
                  >
                    {opening === profile.id
                      ? '正在核对入口…'
                      : target
                        ? '开始对话'
                        : profile.is_default
                          ? '连接你的 Dot'
                          : '准备对话'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {!loading && !profilesError && !sorted.length && (
          <div className="product-empty">
            <p>你的团队还没有 Bot。</p>
            <Link
              to="/agent-profiles?create=1"
              className="product-action-secondary"
            >
              创建第一个 Bot
            </Link>
          </div>
        )}
      </section>
      <CreateContainerDialog
        open={!!creatingProfile}
        initialAgentProfileId={creatingProfile?.id}
        onClose={() => setCreatingProfile(null)}
        onCreated={(jid) => {
          const profile = creatingProfile;
          setCreatingProfile(null);
          if (
            profile &&
            profile.owner_user_id === useAuthStore.getState().user?.id
          )
            void openBot(profile, jid);
        }}
      />
    </main>
  );
}
