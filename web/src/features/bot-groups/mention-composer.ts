import type { BotDisplayIdentity } from '../../../../src/personal-agent/team-product-types';
export type MentionBot = { id: string; name: string; bot?: BotDisplayIdentity };
export function mentionQuery(value: string, caret: number) {
  const prefix = value.slice(0, caret),
    match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  return match
    ? { start: caret - match[1].length - 1, end: caret, query: match[1] }
    : null;
}
export function insertMention(value: string, caret: number, bot: MentionBot) {
  const query = mentionQuery(value, caret);
  if (!query) return { value, caret };
  const token = '@' + bot.name + ' ';
  return {
    value: value.slice(0, query.start) + token + value.slice(caret),
    caret: query.start + token.length,
  };
}
export function retainMentions(
  value: string,
  ids: string[],
  bots: MentionBot[],
) {
  return [...new Set(ids)].filter((id) => {
    const bot = bots.find((item) => item.id === id);
    if (!bot) return false;
    const escaped = bot.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      '(?:^|\\s)@' + escaped + '(?=$|[\\s,，。.!！?？;；:：])',
      'u',
    ).test(value);
  });
}
