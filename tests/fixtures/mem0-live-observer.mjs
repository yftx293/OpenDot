import fs from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const isMem0 = url.startsWith('https://api.mem0.ai/v3/memories/');
  if (!isMem0) return original(input, init);
  const operation = url.includes('/add/') ? 'add' : 'search';
  let app_id, scope;
  try {
    const body = JSON.parse(init.body);
    app_id = operation === 'add' ? body.app_id : body.filters?.AND?.[0]?.app_id;
    if (operation === 'add')
      scope = {
        app_id: body.app_id,
        user_id: body.user_id,
        agent_id: body.agent_id,
        run_id: body.run_id,
      };
  } catch {}
  try {
    const response = await original(input, init);
    fs.appendFileSync(
      process.env.OPENDOT_REAL_MEM0_LEDGER,
      JSON.stringify({ operation, status: response.status, app_id, scope }) +
        '\n',
      { mode: 0o600 },
    );
    return response;
  } catch (e) {
    fs.appendFileSync(
      process.env.OPENDOT_REAL_MEM0_LEDGER,
      JSON.stringify({
        operation,
        status: 'network_error',
        code: e?.cause?.code ?? e?.name,
        app_id,
      }) + '\n',
      { mode: 0o600 },
    );
    throw e;
  }
};
