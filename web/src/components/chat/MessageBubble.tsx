import { useState, useRef, memo, lazy, Suspense } from 'react';
import {
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  ImageDown,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Message } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { BotIdentityAvatar } from '../common/BotIdentityAvatar';
import { MessageContextMenu } from './MessageContextMenu';
import { MessageDetailsSheet } from './MessageDetailsSheet';
import { ConversationMessageBody } from './ConversationMessageBody';
import { ImageLightbox } from './ImageLightbox';
import { mediumTap } from '../../hooks/useHaptic';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { formatThinkingDuration } from '../../utils/thinking-duration';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import { getPresentedMessageContent } from '../../lib/message-presentation';
import { getMessageDisplayTimestamp } from '../../lib/message-timeline';
import {
  getAuthoritativeTokenBreakdown,
  getDisplayedTokenTotal,
  getPrimaryModelUsage,
  parseTokenUsage,
} from '../../lib/token-usage-presentation';
import { WorkflowRunCard } from './WorkflowRunCard';
import type { WorkflowRunSnapshot } from '../../stream-event.types';

const ShareImageDialog = lazy(() =>
  import('./ShareImageDialog').then((m) => ({ default: m.ShareImageDialog })),
);

interface MessageBubbleProps {
  message: Message;
  showTime: boolean;
  showAuthor?: boolean;
  thinkingContent?: string;
  thinkingDurationMs?: number;
  agentName?: string;
  agentProfileId?: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
  agentAvatarShape?: string | null;
}

interface MessageAttachment {
  type: 'image';
  data: string; // base64
  mimeType?: string;
  name?: string;
}

/** Collapsible reasoning block for AI messages */
function ReasoningBlock({
  content,
  durationMs,
}: {
  content: string;
  durationMs?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const label =
    durationMs != null && durationMs > 0
      ? formatThinkingDuration(durationMs)
      : 'Reasoning';

  return (
    <div className="mb-3 rounded-xl border border-amber-200/60 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-950/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 pr-16 text-left hover:bg-amber-50/60 dark:hover:bg-amber-950/40 transition-colors"
      >
        <svg
          className="w-4 h-4 text-amber-500 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z"
          />
        </svg>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {label}
        </span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-amber-400" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 text-sm text-amber-900/70 dark:text-amber-300/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto border-t border-amber-100 dark:border-amber-800/40">
          {content}
        </div>
      )}
    </div>
  );
}

/** Parse and display token usage for AI messages */
function TokenUsageDisplay({
  tokenUsageJson,
  workflowRuns = [],
}: {
  tokenUsageJson: string;
  workflowRuns?: WorkflowRunSnapshot[];
}) {
  const usage = parseTokenUsage(tokenUsageJson);

  if (!usage) return null;

  // 主模型 = 费用最高的（即用户指定的模型），内部模型不向用户展示
  const primary = getPrimaryModelUsage(usage);
  const breakdown = getAuthoritativeTokenBreakdown(usage);
  const workflowTokens = workflowRuns.reduce(
    (total, run) => total + (run.totalTokens || 0),
    0,
  );
  // Workflow subagents are billed outside the main assistant-message usage
  // payload. Present both authorities together instead of showing a false 0.
  const displayTotal = getDisplayedTokenTotal(
    usage,
    workflowRuns.map((run) => run.totalTokens),
  );

  const formatNum = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const summaryContent = (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-default">
      {displayTotal > 0 && <span>{formatNum(displayTotal)} tokens</span>}
      {usage.durationMs ? (
        <>
          {displayTotal > 0 && <span className="opacity-40">·</span>}
          <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
        </>
      ) : null}
    </span>
  );

  if (displayTotal === 0 && !usage.durationMs) return null;

  const hasDetails = displayTotal > 0 || primary !== null;

  if (!hasDetails) {
    return <div className="mt-1.5">{summaryContent}</div>;
  }

  return (
    <div className="mt-1.5">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>{summaryContent}</TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            <div className="text-xs space-y-0.5">
              {primary && (
                <div className="opacity-70 font-medium mb-1">
                  主模型：{primary[0]}
                </div>
              )}
              {breakdown.totalTokens > 0 && (
                <div>
                  输入 {formatNum(breakdown.inputTokens)} / 输出{' '}
                  {formatNum(breakdown.outputTokens)}
                </div>
              )}
              {workflowTokens > 0 && (
                <div className="opacity-70">
                  Workflow Agent 合计 {formatNum(workflowTokens)}
                </div>
              )}
              {(breakdown.cacheReadInputTokens > 0 ||
                breakdown.cacheCreationInputTokens > 0 ||
                breakdown.reasoningTokens > 0) && (
                <div className="opacity-70">
                  缓存读取 {formatNum(breakdown.cacheReadInputTokens)} /
                  缓存写入 {formatNum(breakdown.cacheCreationInputTokens)} /
                  推理 {formatNum(breakdown.reasoningTokens)}
                </div>
              )}
              {primary && (
                <div className="opacity-70">
                  主模型输入 {formatNum(primary[1].inputTokens || 0)} / 输出{' '}
                  {formatNum(primary[1].outputTokens || 0)}
                </div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export const MessageBubble = memo(
  function MessageBubble({
    message,
    showTime,
    showAuthor = true,
    thinkingContent,
    thinkingDurationMs,
    agentName,
    agentProfileId,
    agentAvatarUrl,
    agentAvatarEmoji,
    agentAvatarColor,
    agentAvatarShape,
  }: MessageBubbleProps) {
    const [copied, setCopied] = useState(false);
    const [lightboxState, setLightboxState] = useState<{
      images: string[];
      index: number;
    } | null>(null);
    const [contextMenu, setContextMenu] = useState<{
      x: number;
      y: number;
    } | null>(null);
    const [showShareDialog, setShowShareDialog] = useState(false);
    const [showDetails, setShowDetails] = useState(false);
    const actions = useRef<HTMLButtonElement>(null);
    const currentUser = useAuthStore((s) => s.user);
    const appearance = useAuthStore((s) => s.appearance);
    const agentIdentity = resolveAgentDisplayIdentity({
      agentName,
      messageSenderName: message.sender_name,
      avatarUrl: agentAvatarUrl,
      avatarEmoji: agentAvatarEmoji,
      avatarColor: agentAvatarColor,
      mainAvatarUrl: appearance?.aiAvatarUrl,
      mainAvatarEmoji:
        appearance?.aiAvatarMode === 'emoji'
          ? appearance.aiAvatarEmoji
          : undefined,
      mainAvatarColor:
        appearance?.aiAvatarMode === 'emoji'
          ? appearance.aiAvatarColor
          : undefined,
    });
    const { mode: displayMode } = useDisplayMode();
    const isUser = !message.is_from_me;
    const presentedContent = getPresentedMessageContent(message);
    const completedWorkflowRuns = message.workflow_runs?.filter(
      (run) => run.status !== 'running',
    );
    const presentedMessage =
      presentedContent === message.content
        ? message
        : { ...message, content: presentedContent };
    const time = new Date(getMessageDisplayTimestamp(message))
      .toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      .replace(/\//g, '-');

    const detailsSheet = (
      <MessageDetailsSheet
        open={showDetails}
        onOpenChange={setShowDetails}
        returnFocus={actions}
        message={{
          id: message.id,
          author: isUser
            ? currentUser?.display_name ||
              currentUser?.username ||
              message.sender_name
            : agentIdentity.name,
          timestamp: getMessageDisplayTimestamp(message),
          source: {
            kind:
              message.source_kind ?? (isUser ? 'user_message' : 'dot_reply'),
            channel: message.source_jid ?? message.chat_jid,
          },
        }}
      >
        {message.is_from_me && message.token_usage && (
          <TokenUsageDisplay
            tokenUsageJson={message.token_usage}
            workflowRuns={completedWorkflowRuns}
          />
        )}
      </MessageDetailsSheet>
    );

    // Parse image attachments
    const attachments: MessageAttachment[] = message.attachments
      ? (() => {
          try {
            return JSON.parse(message.attachments);
          } catch {
            return [];
          }
        })()
      : [];
    const images = attachments.filter((att) => att.type === 'image');
    const allImageSrcs = images.map(
      (img) => `data:${img.mimeType || 'image/png'};base64,${img.data}`,
    );

    // Check if content is empty (only whitespace) and we have images
    const hasOnlyImages = !presentedContent.trim() && images.length > 0;

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(presentedContent);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = presentedContent;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    };

    const handleMenuButton = (e: React.MouseEvent | React.TouchEvent) => {
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      mediumTap();
      setContextMenu({ x: rect.left, y: rect.bottom + 4 });
    };

    // Context overflow system message
    if (
      message.sender === '__system__' &&
      message.content.startsWith('context_overflow:')
    ) {
      const errorMsg = message.content.replace(/^context_overflow:\s*/, '');
      return (
        <div className="mb-6">
          {showTime && (
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-muted-foreground">{time}</span>
              <span className="text-xs font-medium text-red-600">系统消息</span>
            </div>
          )}
          <div className="relative bg-red-50 dark:bg-red-950/30 rounded-xl border border-red-200 dark:border-red-800/60 border-l-[3px] border-l-red-500 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
                !
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-red-900 dark:text-red-200 mb-1">
                  上下文溢出错误
                </h3>
                <p className="text-sm text-red-800 dark:text-red-300 leading-relaxed">
                  {errorMsg}
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Billing system message (quota exceeded / insufficient balance)
    if (message.sender === '__billing__') {
      const displayMsg = message.content.replace(/^⚠️\s*/, '');
      const isBalanceBlocked = displayMsg.includes('充值余额后继续使用');
      // Detect which quota window was exceeded
      const windowLabels: Record<string, string> = {
        daily: '日度',
        weekly: '周度',
        monthly: '月度',
      };
      let exceededWindow = '';
      if (displayMsg.includes('日度')) exceededWindow = 'daily';
      else if (displayMsg.includes('周度')) exceededWindow = 'weekly';
      else if (displayMsg.includes('月度')) exceededWindow = 'monthly';
      const windowTag = isBalanceBlocked
        ? '余额'
        : windowLabels[exceededWindow] || '配额';
      // Extract reset hint if present (e.g. "约 3 小时后重置" or "约 1 天后重置")
      const resetMatch = displayMsg.match(/约\s*(\d+)\s*(小时|天)后重置/);
      return (
        <div className="mb-6">
          {showTime && (
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-muted-foreground">{time}</span>
              <span className="text-xs font-medium text-amber-600">
                {isBalanceBlocked ? '余额提醒' : '配额提醒'}
              </span>
            </div>
          )}
          <div className="relative bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-800 border-l-[3px] border-l-amber-500 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-amber-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
                !
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                    {isBalanceBlocked ? '余额不足' : `${windowTag}配额已用完`}
                  </h3>
                  {!isBalanceBlocked && exceededWindow && (
                    <span
                      className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                        exceededWindow === 'daily'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                          : exceededWindow === 'weekly'
                            ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300'
                            : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                      }`}
                    >
                      {windowTag}限额
                    </span>
                  )}
                </div>
                <p className="text-sm text-amber-800 dark:text-amber-300 leading-relaxed">
                  {displayMsg}
                </p>
                {resetMatch && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    预计 {resetMatch[1]} {resetMatch[2]}后自动重置
                  </p>
                )}
                <Link
                  to="/billing"
                  className="inline-block mt-2 text-sm text-primary hover:underline font-medium"
                >
                  查看账单 &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // ── Compact mode: all messages left-aligned, no bubbles, full-width ──
    if (displayMode === 'compact') {
      const isAI = message.is_from_me;
      const senderName = isAI
        ? agentIdentity.name
        : currentUser?.display_name || currentUser?.username || '我';

      return (
        <div className="group mb-2 border-b border-border pb-2">
          {/* Sender line — no avatars in compact mode */}
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className={`text-xs font-semibold ${isAI ? 'text-primary' : 'text-muted-foreground'}`}
            >
              {showAuthor ? (
                senderName
              ) : (
                <span className="sr-only">{senderName}</span>
              )}
            </span>
            {showTime && (
              <span className="text-[11px] text-muted-foreground">{time}</span>
            )}
            <button
              onClick={handleCopy}
              className="ml-1 min-w-11 min-h-11 rounded flex items-center justify-center text-muted-foreground/50 hover:text-foreground/70 opacity-100 transition-opacity cursor-pointer"
              title="复制"
            >
              {copied ? (
                <Check className="w-3 h-3 text-primary" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
            <button
              ref={actions}
              onClick={handleMenuButton}
              className="product-icon-action"
              aria-label="消息菜单"
            >
              <Ellipsis size={17} />
            </button>
            {isAI && (
              <button
                onClick={() => setShowShareDialog(true)}
                className="min-w-11 min-h-11 rounded flex items-center justify-center text-muted-foreground/50 hover:text-foreground/70 opacity-100 transition-opacity cursor-pointer"
                title="导出为长图"
                aria-label="导出为长图"
              >
                <ImageDown className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Dynamic Workflow */}
          {completedWorkflowRuns?.map((run) => (
            <WorkflowRunCard key={run.taskId} run={run} />
          ))}

          {/* Reasoning */}
          {thinkingContent && (
            <ReasoningBlock
              content={thinkingContent}
              durationMs={thinkingDurationMs}
            />
          )}

          {/* Images */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                  alt={img.name || `图片 ${i + 1}`}
                  className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border border-border hover:border-primary transition-colors"
                  onClick={() =>
                    setLightboxState({ images: allImageSrcs, index: i })
                  }
                />
              ))}
            </div>
          )}

          {/* Content — strip first-child top margin for consistent spacing */}
          {!hasOnlyImages && (
            <div className="min-w-0 overflow-hidden [&>div>*:first-child]:!mt-0">
              {isAI ? (
                <ConversationMessageBody
                  content={presentedContent}
                  bot
                  groupJid={message.chat_jid}
                />
              ) : (
                <ConversationMessageBody
                  content={presentedContent}
                  bot={false}
                />
              )}
            </div>
          )}

          {/* Token usage (compact mode) */}

          {lightboxState && (
            <ImageLightbox
              images={lightboxState.images}
              initialIndex={lightboxState.index}
              onClose={() => setLightboxState(null)}
            />
          )}
          {detailsSheet}
          {contextMenu && (
            <MessageContextMenu
              content={presentedContent}
              position={contextMenu}
              onClose={() => {
                setContextMenu(null);
                actions.current?.focus();
              }}
              chatJid={message.chat_jid}
              messageId={message.id}
              allowFeedback={isAI}
              onDetails={() => setShowDetails(true)}
              onShareImage={isAI ? () => setShowShareDialog(true) : undefined}
            />
          )}
          {showShareDialog && (
            <Suspense>
              <ShareImageDialog
                onClose={() => setShowShareDialog(false)}
                message={presentedMessage}
                agentName={agentIdentity.name}
                agentAvatarUrl={agentAvatarUrl}
                agentAvatarEmoji={agentAvatarEmoji}
                agentAvatarColor={agentAvatarColor}
              />
            </Suspense>
          )}
        </div>
      );
    }

    // ── Chat mode (default): bubble-style layout ──
    if (isUser) {
      // User message: right-aligned
      return (
        <div className="group flex justify-end mb-4">
          <div className="flex flex-col items-end min-w-0 max-w-[75%]">
            <div className="relative">
              {/* Image attachments */}
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2 justify-end">
                  {images.map((img, i) => (
                    <img
                      key={i}
                      src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                      alt={img.name || `图片 ${i + 1}`}
                      className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border-2 border-primary hover:border-primary transition-colors"
                      onClick={() =>
                        setLightboxState({ images: allImageSrcs, index: i })
                      }
                    />
                  ))}
                </div>
              )}
              {!hasOnlyImages && (
                <div className="bg-muted text-foreground px-4 py-2.5 rounded-2xl rounded-tr-sm">
                  <ConversationMessageBody
                    content={presentedContent}
                    bot={false}
                  />
                </div>
              )}
              <button
                ref={actions}
                onClick={handleMenuButton}
                className="absolute -left-12 top-1/2 -translate-y-1/2 min-w-11 min-h-11 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/10 opacity-100 transition-all cursor-pointer"
                title="更多"
                aria-label="消息菜单"
              >
                <Ellipsis className="w-4 h-4" />
              </button>
            </div>
            {showTime && (
              <span className="text-xs text-muted-foreground mt-1.5 mr-1">
                {time}
              </span>
            )}
          </div>

          {lightboxState && (
            <ImageLightbox
              images={lightboxState.images}
              initialIndex={lightboxState.index}
              onClose={() => setLightboxState(null)}
            />
          )}
          {detailsSheet}
          {contextMenu && (
            <MessageContextMenu
              content={presentedContent}
              position={contextMenu}
              onClose={() => {
                setContextMenu(null);
                actions.current?.focus();
              }}
              chatJid={message.chat_jid}
              messageId={message.id}
              onDetails={() => setShowDetails(true)}
            />
          )}
        </div>
      );
    }

    const senderName = agentIdentity.name;

    return (
      <div className="group mb-4">
        {/* Mobile: compact avatar + name row */}
        <div
          className={
            showAuthor ? 'flex items-center gap-2 mb-1.5 lg:hidden' : 'sr-only'
          }
        >
          {agentProfileId ? (
            <BotIdentityAvatar
              bot={{
                profile_id: agentProfileId,
                name: senderName,
                avatar_url: agentAvatarUrl,
                avatar_emoji: agentAvatarEmoji,
                avatar_color: agentAvatarColor,
                avatar_shape: agentAvatarShape,
              }}
              size="sm"
            />
          ) : (
            <EmojiAvatar
              imageUrl={agentIdentity.imageUrl}
              emoji={agentIdentity.emoji}
              color={agentIdentity.color}
              fallbackChar={agentIdentity.fallbackChar}
              size="sm"
            />
          )}
          <span className="text-xs text-muted-foreground font-medium">
            {senderName}
          </span>
          {showTime && (
            <span className="text-xs text-muted-foreground">{time}</span>
          )}
        </div>

        {/* Desktop: horizontal avatar + content layout */}
        <div className="lg:flex lg:gap-3">
          <div
            className={
              showAuthor
                ? 'hidden lg:block flex-shrink-0'
                : 'invisible hidden lg:block flex-shrink-0'
            }
          >
            {agentProfileId ? (
              <BotIdentityAvatar
                bot={{
                  profile_id: agentProfileId,
                  name: senderName,
                  avatar_url: agentAvatarUrl,
                  avatar_emoji: agentAvatarEmoji,
                  avatar_color: agentAvatarColor,
                  avatar_shape: agentAvatarShape,
                }}
                size="md"
              />
            ) : (
              <EmojiAvatar
                imageUrl={agentIdentity.imageUrl}
                emoji={agentIdentity.emoji}
                color={agentIdentity.color}
                fallbackChar={agentIdentity.fallbackChar}
                size="md"
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            {/* Desktop: name + time row */}
            <div
              className={
                showAuthor
                  ? 'hidden lg:flex items-center gap-2 mb-1'
                  : 'sr-only'
              }
            >
              <span className="text-xs text-muted-foreground font-medium">
                {senderName}
              </span>
              {showTime && (
                <span className="text-xs text-muted-foreground">{time}</span>
              )}
            </div>

            {/* Claude-style: no card container, direct content */}
            <div className="overflow-hidden font-serif">
              {completedWorkflowRuns?.map((run) => (
                <WorkflowRunCard key={run.taskId} run={run} />
              ))}

              {/* Reasoning block — muted left border style */}
              {thinkingContent && (
                <ReasoningBlock
                  content={thinkingContent}
                  durationMs={thinkingDurationMs}
                />
              )}

              {/* Image attachments */}
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {images.map((img, i) => (
                    <img
                      key={i}
                      src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
                      alt={img.name || `图片 ${i + 1}`}
                      className="max-w-48 max-h-48 rounded-lg object-cover cursor-pointer border border-border hover:border-primary transition-colors"
                      onClick={() =>
                        setLightboxState({ images: allImageSrcs, index: i })
                      }
                    />
                  ))}
                </div>
              )}

              {/* Content */}
              {!hasOnlyImages && (
                <div className="max-w-none overflow-hidden">
                  <ConversationMessageBody
                    content={presentedContent}
                    bot
                    groupJid={message.chat_jid}
                  />
                </div>
              )}

              {/* Token usage */}
            </div>

            {/* Action toolbar — below content, Claude-style */}
            <div className="flex items-center gap-0.5 mt-1 opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="min-h-11 min-w-11 px-2 rounded-md flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs cursor-pointer transition-colors"
                title="复制"
                aria-label="复制消息"
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5 text-primary" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                onClick={() => setShowShareDialog(true)}
                className="min-h-11 min-w-11 px-2 rounded-md flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs max-lg:hidden cursor-pointer transition-colors"
                title="分享"
                aria-label="生成分享图片"
              >
                <ImageDown className="w-3.5 h-3.5" />
              </button>
              <button
                ref={actions}
                onClick={handleMenuButton}
                className="min-h-11 min-w-11 px-2 rounded-md flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs cursor-pointer transition-colors"
                title="更多"
                aria-label="消息菜单"
              >
                <Ellipsis className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {lightboxState && (
          <ImageLightbox
            images={lightboxState.images}
            initialIndex={lightboxState.index}
            onClose={() => setLightboxState(null)}
          />
        )}
        {detailsSheet}
        {contextMenu && (
          <MessageContextMenu
            content={presentedContent}
            position={contextMenu}
            onClose={() => {
              setContextMenu(null);
              actions.current?.focus();
            }}
            chatJid={message.chat_jid}
            messageId={message.id}
            allowFeedback
            onDetails={() => setShowDetails(true)}
            onShareImage={() => setShowShareDialog(true)}
          />
        )}
        {showShareDialog && (
          <Suspense>
            <ShareImageDialog
              onClose={() => setShowShareDialog(false)}
              message={presentedMessage}
              agentName={agentIdentity.name}
              agentAvatarUrl={agentAvatarUrl}
              agentAvatarEmoji={agentAvatarEmoji}
              agentAvatarColor={agentAvatarColor}
            />
          </Suspense>
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.token_usage === next.message.token_usage &&
    prev.showTime === next.showTime &&
    prev.showAuthor === next.showAuthor &&
    prev.thinkingContent === next.thinkingContent &&
    prev.thinkingDurationMs === next.thinkingDurationMs &&
    prev.agentName === next.agentName &&
    prev.agentProfileId === next.agentProfileId &&
    prev.agentAvatarUrl === next.agentAvatarUrl &&
    prev.agentAvatarEmoji === next.agentAvatarEmoji &&
    prev.agentAvatarColor === next.agentAvatarColor &&
    prev.agentAvatarShape === next.agentAvatarShape,
);
