import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Ellipsis, ThumbsDown, ThumbsUp } from 'lucide-react';
import type {
  BotGroupMessage,
  BotGroupSnapshot,
} from '../../../../src/bot-groups/types';
import { BotIdentityAvatar } from '../../components/common/BotIdentityAvatar';
import { memberIdentity } from '../../components/common/bot-avatar/product-state';
import { MessageDetailsSheet } from '../../components/chat/MessageDetailsSheet';
import { api } from '../../api/client';
import { showToast } from '../../utils/toast';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../../components/ui/dropdown-menu';

export function GroupConversationMessage({
  message,
  snapshot,
  actor,
  grouped,
  verified,
  children,
}: {
  message: BotGroupMessage;
  snapshot: BotGroupSnapshot;
  actor?: string;
  grouped: boolean;
  verified: boolean;
  children: ReactNode;
}) {
  const [details, setDetails] = useState(false);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const actions = useRef<HTMLButtonElement>(null);
  const author =
    message.author_kind === 'user' && message.author_id === actor
      ? '你'
      : message.author_name;
  const member = snapshot.members.find(
    (m) => m.kind === 'bot' && m.subject_id === message.author_id,
  );
  const sendFeedback = async (score: -1 | 1) => {
    if (savingFeedback) return;
    setSavingFeedback(true);
    try {
      const target = `/api/bot-groups/${encodeURIComponent(snapshot.group.id)}/messages/${encodeURIComponent(message.id)}/feedback`;
      const current = await api.get<{ feedback: { version: number } | null }>(
        target,
      );
      await api.put(target, {
        score,
        expectedVersion: current.feedback?.version ?? 0,
        requestId: crypto.randomUUID(),
      });
      showToast('反馈已保存');
    } catch {
      showToast('反馈未保存', '请稍后重试。');
    } finally {
      setSavingFeedback(false);
    }
  };
  return (
    <article
      data-message-id={message.id}
      data-seq={message.seq}
      data-grouped={grouped}
      className="group-message"
      data-author-kind={message.author_kind}
      data-self={message.author_kind === 'user' && message.author_id === actor}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 text-xs text-muted-foreground">
        {!grouped ? (
          <span className="inline-flex items-center gap-2">
            {message.author_kind === 'bot' && (
              <Link
                to={'/bots?profile=' + encodeURIComponent(message.author_id)}
                aria-label={'打开 ' + message.author_name + ' 的聊天'}
                className="inline-flex size-11 shrink-0 items-center justify-center"
              >
                <BotIdentityAvatar
                  bot={
                    member
                      ? memberIdentity(member)
                      : {
                          profile_id: message.author_id,
                          name: message.author_name,
                        }
                  }
                  state={
                    verified &&
                    snapshot.discussion?.run?.status === 'running' &&
                    snapshot.discussion.run.current_speaker_profile_id ===
                      message.author_id
                      ? 'thinking'
                      : 'idle'
                  }
                  size="xs"
                />
              </Link>
            )}
            {author}
          </span>
        ) : (
          <span className="sr-only">{author}</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={actions}
              type="button"
              className="product-icon-action ml-auto"
              aria-label="消息菜单"
            >
              <Ellipsis size={17} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (details) event.preventDefault();
            }}
          >
            {message.author_kind === 'bot' && (
              <>
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={savingFeedback}
                  onSelect={() => void sendFeedback(1)}
                >
                  <ThumbsUp className="mr-2 h-4 w-4" />
                  有帮助
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  disabled={savingFeedback}
                  onSelect={() => void sendFeedback(-1)}
                >
                  <ThumbsDown className="mr-2 h-4 w-4" />
                  没帮助
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem
              className="min-h-11"
              onSelect={() => setDetails(true)}
            >
              消息详情
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {children}
      <MessageDetailsSheet
        open={details}
        onOpenChange={setDetails}
        returnFocus={actions}
        message={{
          id: message.id,
          author: message.author_name,
          timestamp: message.created_at,
          source: message.source,
          sequence: message.seq,
        }}
      />
    </article>
  );
}
