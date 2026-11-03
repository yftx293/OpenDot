import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, MessageCircle } from 'lucide-react';
import type { BotDisplayIdentity } from '../../../../src/personal-agent/team-product-types';
import { BotIdentityAvatar } from '../../components/common/BotIdentityAvatar';
import type { BotAvatarState } from '../../components/common/BotAvatar';

export function ChiefComposer({
  onSend,
  onInspect,
  pending,
  available,
  bot,
  avatarState,
}: {
  onSend: (text: string) => Promise<boolean>;
  onInspect: () => void;
  pending: boolean;
  available: boolean;
  bot?: BotDisplayIdentity;
  avatarState?: BotAvatarState;
}) {
  const [text, setText] = useState(''),
    [uncertain, setUncertain] = useState(false),
    [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false);
  useLayoutEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height =
      Math.min(200, Math.max(100, textarea.current.scrollHeight)) + 'px';
  }, [text]);
  async function send() {
    if (
      !text.trim() ||
      pending ||
      sending ||
      !available ||
      uncertain ||
      composing.current
    )
      return;
    setSending(true);
    try {
      if (await onSend(text.trim())) setText('');
      else setUncertain(true);
    } finally {
      setSending(false);
    }
  }
  return (
    <section className="chief-composer" aria-label="与 Dot 对话">
      <div className="chief-greeting">
        {bot ? (
          <BotIdentityAvatar bot={bot} state={avatarState} size="lg" />
        ) : (
          <span aria-hidden="true">✦</span>
        )}
        <p>
          {new Date().getHours() < 12
            ? '早上好'
            : new Date().getHours() < 18
              ? '下午好'
              : '晚上好'}
        </p>
      </div>
      <h1>今天需要我帮你处理什么？</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        className="chief-input-surface"
      >
        <textarea
          ref={textarea}
          aria-label="告诉 Dot 你想做什么"
          placeholder="告诉 Dot 你的想法…"
          value={text}
          maxLength={16000}
          disabled={pending || sending || uncertain || !available}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="chief-input-footer">
          <span>
            {available ? 'Dot 会在原来的对话中接手' : '正在连接你的 Dot…'}
          </span>
          <button
            type="submit"
            aria-label="发送给 Dot"
            disabled={
              !text.trim() || pending || sending || uncertain || !available
            }
          >
            <ArrowUp size={19} />
          </button>
        </div>
      </form>
      {uncertain && (
        <div className="chief-submit-review" role="alert">
          <p>尚未确认提交。先查看原对话，再决定是否补充消息。</p>
          <button
            type="button"
            onClick={onInspect}
            className="min-h-11 inline-flex items-center gap-2 underline"
          >
            <MessageCircle size={16} />
            查看 Dot 对话
          </button>
        </div>
      )}
    </section>
  );
}
