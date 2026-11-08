import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// This is a diagnostic projection, not a log export. Never copy text, arguments,
// headers, errors or model replies from the disposable database into the DTO.
export function summarizeLiveRecords(records: unknown[]) {
  const calls: { tool: string; pathMatches?: boolean; contentType?: string }[] =
    [];
  const results: { tool: string; failed: boolean }[] = [];
  const stops: string[] = [];
  const signals = new Set<string>();
  const toolName = (value: unknown) =>
    value === 'read_workspace_file' || value === 'create_approved_artifact'
      ? value
      : 'other';
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    const row = value as Record<string, unknown>;
    if (row.type === 'toolCall') {
      const args = row.arguments as Record<string, unknown> | undefined;
      calls.push({
        tool: toolName(row.name),
        ...(row.name === 'read_workspace_file'
          ? { pathMatches: args?.path === 'team-proof.txt' }
          : row.name === 'create_approved_artifact'
            ? { contentType: typeof args?.content }
            : {}),
      });
    }
    if (row.role === 'toolResult')
      results.push({
        tool: toolName(row.toolName),
        failed: row.isError === true,
      });
    if (
      ['stop', 'toolUse', 'length', 'error', 'aborted'].includes(
        String(row.stopReason),
      )
    )
      stops.push(String(row.stopReason));
    const errorText = [
      row.errorMessage,
      row.error ? JSON.stringify(row.error) : undefined,
      row.role === 'toolResult' && row.isError === true
        ? JSON.stringify(row.content)
        : undefined,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    for (const code of [
      'ENOENT',
      'EACCES',
      'SQLITE_BUSY',
      'BOT_HANDOFF_MODEL_BUDGET_EXHAUSTED',
      'Invalid arguments',
      'fetch failed',
      'MODEL_REQUEST_TIMEOUT',
      'MODEL_PROVIDER_STREAM_ENDED',
      'Stream ended without finish_reason',
      'Provider finish_reason: network_error',
      'Request was aborted',
      'ECONNRESET',
      'ETIMEDOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_INVALID_ARG',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'Connection error',
      'terminated',
    ])
      if (errorText.includes(code)) signals.add(code);
    for (const code of [
      '400',
      '401',
      '403',
      '408',
      '409',
      '413',
      '429',
      '500',
      '502',
      '503',
      '504',
    ])
      if (new RegExp('\\b' + code + '\\b', 'i').test(errorText))
        signals.add('HTTP_' + code);
    Object.values(row).forEach(walk);
  };
  records.forEach(walk);
  return { calls, results, stops, signals: [...signals] };
}

export function liveFailureEvidence(
  root: string,
  log: string,
  processId?: number,
) {
  const readiness = {
    webStarted: log
      .split('\n')
      .some(
        (line) =>
          line.includes('Web server started') &&
          (processId === undefined ||
            line.includes(`(${processId})`) ||
            line.includes(`"pid":${processId},`)),
      ),
    signals: [
      'EADDRINUSE',
      'SQLITE_BUSY',
      'SQLITE_CORRUPT',
      'ERR_MODULE_NOT_FOUND',
    ].filter((code) => log.includes(code)),
  };
  const filename = path.join(root, 'data/db/messages.db');
  if (!fs.existsSync(filename)) return { readiness, handoffs: [] };
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const rows = db
      .prepare(
        'SELECT state, model_attempts, session_id FROM bot_group_handoffs ORDER BY created_at,id',
      )
      .all();
    return {
      readiness,
      handoffs: rows.map((row) => {
        const session = String(row.session_id ?? '');
        const basic = {
          state: [
            'pending',
            'running',
            'waiting_for_approval',
            'waiting_for_device',
            'completed',
            'failed',
            'cancelled',
            'uncertain',
            'paused',
          ].includes(String(row.state))
            ? String(row.state)
            : 'unknown',
          attempts: Number(row.model_attempts),
        };
        if (!/^[a-f0-9-]{36}$/i.test(session)) return basic;
        const file = path.join(
          root,
          'data/db/durable-sessions',
          session + '.sqlite',
        );
        if (!fs.existsSync(file)) return basic;
        const durable = new DatabaseSync(file, { readOnly: true });
        try {
          const entries = durable
            .prepare(
              'SELECT record FROM entries ORDER BY commit_seq DESC LIMIT 64',
            )
            .all();
          const tasks = durable
            .prepare('SELECT record FROM tasks LIMIT 64')
            .all();
          return {
            ...basic,
            ...summarizeLiveRecords(
              [...entries, ...tasks].map((entry) =>
                JSON.parse(String(entry.record)),
              ),
            ),
          };
        } finally {
          durable.close();
        }
      }),
    };
  } finally {
    db.close();
  }
}
