import fs from 'node:fs';
const nativeFetch = globalThis.fetch;
let privateNamespace;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.mem0.ai/v3/memories/'))
    return nativeFetch(url, options);
  const body = JSON.parse(String(options.body));
  const kind = String(url).includes('/search/') ? 'search' : 'add';
  fs.appendFileSync(
    process.env.TEST_MEM0_LEDGER,
    JSON.stringify({ kind, body }) + '\n',
  );
  if (kind === 'add')
    return Response.json({ status: 'PENDING', event_id: 'fixture-event' });
  const and = body.filters.AND;
  const namespace = JSON.stringify(and);
  privateNamespace ??= namespace;
  if (namespace !== privateNamespace) return Response.json({ results: [] });
  return Response.json({
    results: [
      {
        id: 'fixture-memory',
        memory: 'MEM0_PRIVATE_TEA_CANARY',
        score: 0.95,
        app_id: and[0].app_id,
        user_id: and[1].OR[0].user_id,
      },
    ],
  });
};
