import { Fragment } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';

type Mention = { id: string; name: string };

/** Mention chips are presentation of authorized IDs, never dispatch controls. */
export function ConversationMessageBody({
  content,
  bot,
  groupJid,
  mentions = [],
}: {
  content: string;
  bot: boolean;
  groupJid?: string;
  mentions?: Mention[];
}) {
  const chip = (mention: Mention) => (
    <span
      data-mentioned-profile-id={mention.id}
      className="rounded bg-muted px-1 text-primary"
      title={'提及 ' + mention.name}
    >
      @{mention.name}
    </span>
  );
  if (bot)
    return (
      <>
        <MarkdownRenderer
          content={content}
          groupJid={groupJid}
          variant="chat"
        />
        {mentions.length > 0 && (
          <span className="inline-flex flex-wrap gap-1">
            {mentions.map((mention) => (
              <Fragment key={mention.id}>{chip(mention)}</Fragment>
            ))}
          </span>
        )}
      </>
    );
  const pieces: { text: string; mention?: Mention }[] = [];
  const found = new Set<string>();
  let rest = content;
  while (rest) {
    const matches = mentions
      .map((mention) => ({ mention, at: rest.indexOf('@' + mention.name) }))
      .filter((match) => match.at >= 0)
      .sort(
        (a, b) => a.at - b.at || b.mention.name.length - a.mention.name.length,
      );
    const next = matches[0];
    if (!next) {
      pieces.push({ text: rest });
      break;
    }
    if (next.at) pieces.push({ text: rest.slice(0, next.at) });
    pieces.push({ text: '', mention: next.mention });
    found.add(next.mention.id);
    rest = rest.slice(next.at + next.mention.name.length + 1);
  }
  return (
    <p className="text-[15px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
      {pieces.map((piece, index) => (
        <Fragment key={index}>
          {piece.mention ? chip(piece.mention) : piece.text}
        </Fragment>
      ))}
      {mentions
        .filter((mention) => !found.has(mention.id))
        .map((mention) => (
          <Fragment key={mention.id}> {chip(mention)}</Fragment>
        ))}
    </p>
  );
}
