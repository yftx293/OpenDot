/** Where a durable completion or approval ping can be delivered after the tab closes. */

export function resolveDurableNoticeJid(input: {
  originSourceJid?: string | null;
  sessionChannelOwner?: string | null;
  mountedChannelJids?: readonly string[];
  isIm: (jid: string) => boolean;
}): string | null {
  const im = (jid?: string | null) => (jid && input.isIm(jid) ? jid : null);
  const origin = im(input.originSourceJid);
  if (origin) return origin;
  const owner = im(input.sessionChannelOwner);
  if (owner) return owner;
  const mounted = (input.mountedChannelJids ?? []).filter((jid) =>
    input.isIm(jid),
  );
  return mounted.length === 1 ? mounted[0] : null;
}

let sender: ((jid: string, text: string) => Promise<unknown>) | null = null;

/** Registered by the process that owns IM connectors. Tests inject their own send. */
export function registerDurableImSender(
  fn: ((jid: string, text: string) => Promise<unknown>) | null,
) {
  sender = fn;
}

export async function deliverDurableNotice(input: {
  claimKey: string;
  kind: 'complete' | 'approval';
  dotName: string;
  originSourceJid?: string | null;
  sessionChannelOwner?: string | null;
  mountedChannelJids?: readonly string[];
  isIm: (jid: string) => boolean;
  claim: (key: string) => boolean;
}): Promise<boolean> {
  const jid = resolveDurableNoticeJid(input);
  if (!sender || !jid || !input.claim(input.claimKey)) return false;
  await sender(jid, durableNoticeText(input.kind, input.dotName));
  return true;
}

export function durableNoticeText(
  kind: 'complete' | 'approval',
  dotName: string,
): string {
  const name =
    !dotName.trim() || dotName.trim() === 'Chief' ? 'Dot' : dotName.trim();
  if (kind === 'approval')
    return `${name} 有一项操作需要你确认。打开会话即可处理。`;
  return `${name} 完成了一项工作。打开会话即可查看。`;
}

export type DurableRestartPlan = 'resume' | 'skip' | 'leave-blocked';

/** Host restart resumes an open node-durable session. It does not mark the input failed. */
export function durableRestartPlan(input: {
  state: 'provisioning' | 'ready' | 'blocked';
  cloud: boolean;
  goal: boolean;
  groupIdle: boolean;
  handoffTerminal: boolean;
}): DurableRestartPlan {
  if (input.state === 'blocked' || input.handoffTerminal)
    return 'leave-blocked';
  if (input.groupIdle || input.cloud || input.goal) return 'skip';
  return 'resume';
}
