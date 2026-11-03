/** A conversation/list label, not a change to the stored execution objective. */
export function workTitle(value: string) {
  const first =
    value
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? '';
  return first.length > 160 ? first.slice(0, 160) + '…' : first || '未命名工作';
}
