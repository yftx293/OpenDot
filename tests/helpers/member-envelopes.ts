import type { ModelBody } from './bot-handoff-http-fixture.js';
export function memberEnvelopes(body: ModelBody): any[] {
  return body.messages
    .filter((m) => m.role === 'user')
    .flatMap((m) => {
      let value: any = m.content;
      for (let depth = 0; depth < 8; depth++) {
        if (Array.isArray(value))
          value = value.map((part) => part.text ?? '').join('');
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch {
            return [];
          }
        }
        if (value?.kind === 'group_member_input') return [value];
        if (!value?.content) return [];
        value = value.content;
      }
      return [];
    });
}
