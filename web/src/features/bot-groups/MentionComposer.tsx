import { useMediaQuery } from '../../hooks/useMediaQuery';
import { BotIdentityAvatar } from '../../components/common/BotIdentityAvatar';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import {
  insertMention,
  mentionQuery,
  retainMentions,
  type MentionBot,
} from './mention-composer';
export function MentionComposer({
  value,
  onChange,
  mentions,
  onMentions,
  bots,
  disabled,
  onSend,
}: {
  value: string;
  onChange: (value: string) => void;
  mentions: string[];
  onMentions: (ids: string[]) => void;
  bots: MentionBot[];
  disabled: boolean;
  onSend: () => void;
}) {
  const desktop = useMediaQuery('(min-width: 768px)');
  const input = useRef<HTMLTextAreaElement>(null),
    container = useRef<HTMLDivElement>(null),
    listId = useId();
  const compositionEndedAt = useRef(0);
  const [caret, setCaret] = useState(0),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    [composing, setComposing] = useState(false);
  useLayoutEffect(() => {
    if (input.current) {
      input.current.style.height = 'auto';
      input.current.style.height =
        Math.min(144, Math.max(52, input.current.scrollHeight)) + 'px';
    }
  }, [value]);
  const query = mentionQuery(value, caret),
    options = query
      ? bots.filter(
          (bot) =>
            bot.name
              .toLocaleLowerCase()
              .includes(query.query.toLocaleLowerCase()) &&
            !mentions.includes(bot.id) &&
            mentions.length < 2,
        )
      : [];
  const shown =
    !composing && !disabled && open && !!query && options.length > 0;
  useLayoutEffect(() => {
    const element = container.current;
    const dock = element?.closest<HTMLElement>('[data-composer-dock]');
    if (!shown || !element || !dock) return;
    // The dock can include Stop, approval and discussion controls above the
    // textarea. Keep the picker above those controls too, as their height changes.
    const measure = () =>
      element.style.setProperty(
        '--mention-dock-offset',
        `${Math.max(0, element.getBoundingClientRect().top - dock.getBoundingClientRect().top)}px`,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    measure();
    return () => {
      observer.disconnect();
      element.style.removeProperty('--mention-dock-offset');
    };
  }, [shown]);
  function select(bot: MentionBot) {
    if (!mentions.includes(bot.id) && mentions.length >= 2) return;
    const next = insertMention(value, caret, bot);
    onChange(next.value);
    onMentions([
      ...new Set([...retainMentions(next.value, mentions, bots), bot.id]),
    ]);
    setOpen(false);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  }
  return (
    <div ref={container} className="group-mention-composer">
      <label className="sr-only" htmlFor={listId + '-input'}>
        群聊消息
      </label>
      <textarea
        id={listId + '-input'}
        ref={input}
        className="group-message-input"
        placeholder="输入消息，使用 @ 选择 Dot…"
        maxLength={16000}
        value={value}
        disabled={disabled}
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={
          shown
            ? `${listId}-${Math.min(active, options.length - 1)}`
            : undefined
        }
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          onMentions(retainMentions(next, mentions, bots));
          setCaret(event.target.selectionStart);
          setOpen(true);
          setActive(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(event) => {
          compositionEndedAt.current = Date.now();
          setComposing(false);
          setCaret(event.currentTarget.selectionStart);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (
            composing ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            (event.key === 'Enter' &&
              Date.now() - compositionEndedAt.current < 200)
          )
            return;
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (!shown) {
            if (event.key === 'Enter' && !event.shiftKey && desktop) {
              event.preventDefault();
              if (!disabled && value.trim()) onSend();
            }
            return;
          }
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            setActive(
              (index) =>
                (index +
                  (event.key === 'ArrowDown' ? 1 : -1) +
                  options.length) %
                options.length,
            );
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            select(options[Math.min(active, options.length - 1)]);
          }
        }}
      />
      {shown && (
        <div
          role="listbox"
          id={listId}
          aria-label="选择提及的 Dot"
          className="group-mention-menu"
        >
          {options.map((bot, index) => (
            <button
              key={bot.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={Math.min(active, options.length - 1) === index}
              type="button"
              className={
                'flex min-h-11 w-full items-center gap-2 rounded px-3 text-left text-sm ' +
                (Math.min(active, options.length - 1) === index
                  ? 'bg-accent'
                  : '')
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(bot)}
            >
              {bot.bot && <BotIdentityAvatar bot={bot.bot} size="xs" />}
              {bot.name}
            </button>
          ))}
        </div>
      )}
      {!!mentions.length && (
        <div className="flex flex-wrap gap-2" aria-label="已选择 Dot">
          {mentions.map((id) => {
            const bot = bots.find((item) => item.id === id);
            return bot ? (
              <button
                key={id}
                type="button"
                className="min-h-11 rounded-full border px-3 text-sm"
                disabled={disabled}
                onClick={() => {
                  onMentions(mentions.filter((value) => value !== id));
                  onChange(value.replace('@' + bot.name, ''));
                }}
              >
                移除 @{bot.name} ×
              </button>
            ) : null;
          })}
        </div>
      )}
      <div className="group-composer-toolbar">
        <button
          type="button"
          className="product-icon-action"
          aria-label="提及 Dot"
          disabled={disabled || mentions.length >= 2}
          onClick={() => {
            const start = input.current?.selectionStart ?? value.length,
              end = input.current?.selectionEnd ?? start;
            const prefix =
              start > 0 && !/\s/.test(value[start - 1]) ? ' @' : '@';
            const next = value.slice(0, start) + prefix + value.slice(end);
            onChange(next);
            onMentions(retainMentions(next, mentions, bots));
            const cursor = start + prefix.length;
            setCaret(cursor);
            setActive(0);
            setOpen(true);
            requestAnimationFrame(() => {
              input.current?.focus();
              input.current?.setSelectionRange(cursor, cursor);
            });
          }}
        >
          @
        </button>
        <span className="text-xs text-muted-foreground">最多提及两个 Dot</span>
      </div>
    </div>
  );
}
