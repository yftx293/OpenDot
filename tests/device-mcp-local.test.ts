import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { mcpDigest } from '../src/mcp-contract.js';
import {
  executeDeviceMcpOnce,
  openDeviceState,
} from '../src/personal-agent/device-local.js';
import {
  DeviceMcpBindingSchema,
  deviceTextDigest,
} from '../src/personal-agent/device-protocol.js';

function binding() {
  const id = randomUUID(),
    node = randomUUID(),
    grant = randomUUID();
  const args = { text: 'safe' },
    hash = 'a'.repeat(64),
    expires = Date.now() + 60_000;
  const intent = {
    version: 1 as const,
    operation: 'mcp.call' as const,
    call_id: id,
    owner_id: 'owner',
    dot_id: randomUUID(),
    workspace_jid: 'web:home',
    session_id: randomUUID(),
    server_id: 'browser',
    original_name: 'read',
    registered_name: 'mcp__browser__read',
    catalog_digest: hash,
    schema_digest: hash,
    server_config_digest: hash,
    arguments_digest: mcpDigest(args),
    location: { kind: 'device' as const, node_id: node },
    source: {
      runtime: 'pi-coding-agent' as const,
      conversation_id: 'conversation',
      business_turn_id: 'turn',
      tool_call_id: 'call',
    },
    grant_id: grant,
    grant_revision: 1,
    cancel_generation: 0,
    expires_at: expires,
  };
  return {
    args,
    command: DeviceMcpBindingSchema.parse({
      version: 2,
      capability: 'mcp',
      id,
      owner_id: intent.owner_id,
      workspace_jid: intent.workspace_jid,
      session_id: intent.session_id,
      dot_id: intent.dot_id,
      node_id: node,
      grant_id: grant,
      device_grant_id: randomUUID(),
      grant_revision: 1,
      cancel_generation: 0,
      manifest_hash: hash,
      server_id: 'browser',
      configuration_digest: hash,
      catalog_digest: hash,
      schema_digest: hash,
      tool_name: 'read',
      call_id: id,
      args_digest: mcpDigest(args),
      expires_at: expires,
      intent,
    }),
  };
}

test('an image attachment receipt is replayed by the original command without redispatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-image-receipt-'));
  try {
    const state = openDeviceState(path.join(root, 'private/node.sqlite'));
    const { command, args } = binding();
    const dispatch = vi.fn(async () => ({
      outcome: 'completed' as const,
      content: '{"content":[]}',
      content_digest: deviceTextDigest('{"content":[]}'),
      attachment: {
        digest: 'b'.repeat(64),
        size: 120,
        mime: 'image/png' as const,
        expires_at: Date.now() + 30000,
      },
    }));
    const first = await executeDeviceMcpOnce(
      state.database,
      command,
      args,
      () => {},
      dispatch,
    );
    const second = await executeDeviceMcpOnce(
      state.database,
      command,
      args,
      () => {},
      dispatch,
    );
    expect(second).toEqual(first);
    expect(dispatch).toHaveBeenCalledTimes(1);
    state.database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revocation while a tool runs hides its result but preserves its receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-mcp-revoked-'));
  try {
    const state = openDeviceState(path.join(root, 'private/node.sqlite'));
    const { command, args } = binding();
    let allowed = true;
    const authorize = () => {
      if (!allowed) throw new Error('revoked');
    };
    const dispatch = vi.fn(async () => {
      allowed = false;
      return {
        outcome: 'completed' as const,
        content: 'private result',
        content_digest: deviceTextDigest('private result'),
      };
    });
    await expect(
      executeDeviceMcpOnce(state.database, command, args, authorize, dispatch),
    ).rejects.toThrow('revoked');
    const receipt = state.database
      .prepare('SELECT state FROM mcp_receipts WHERE id=?')
      .get(command.id);
    expect(receipt).toEqual({ state: 'settled' });
    await expect(
      executeDeviceMcpOnce(state.database, command, args, authorize, dispatch),
    ).rejects.toThrow('revoked');
    allowed = true;
    expect(
      await executeDeviceMcpOnce(
        state.database,
        command,
        args,
        authorize,
        dispatch,
      ),
    ).toMatchObject({ outcome: 'completed' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    state.database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expired command cannot disclose an existing result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-mcp-expired-'));
  try {
    const state = openDeviceState(path.join(root, 'private/node.sqlite'));
    const { command, args } = binding();
    const dispatch = vi.fn(async () => ({
      outcome: 'completed' as const,
      content: 'private',
      content_digest: deviceTextDigest('private'),
    }));
    await executeDeviceMcpOnce(
      state.database,
      command,
      args,
      () => {},
      dispatch,
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(command.expires_at + 1);
    try {
      await expect(
        executeDeviceMcpOnce(state.database, command, args, () => {}, dispatch),
      ).rejects.toThrow('authority unavailable');
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      state.database.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('device MCP receipts persist and never dispatch the same intent twice', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-mcp-'));
  try {
    const state = openDeviceState(path.join(root, 'private/node.sqlite'));
    const { command, args } = binding();
    const dispatch = vi.fn(async () => ({
      outcome: 'completed' as const,
      content: 'ok',
      content_digest: deviceTextDigest('ok'),
    }));
    expect(
      await executeDeviceMcpOnce(
        state.database,
        command,
        args,
        () => {},
        dispatch,
      ),
    ).toMatchObject({ outcome: 'completed' });
    state.database.close();
    const reopened = openDeviceState(state.filename);
    expect(
      await executeDeviceMcpOnce(
        reopened.database,
        command,
        args,
        () => {},
        dispatch,
      ),
    ).toMatchObject({ outcome: 'completed' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(
      executeDeviceMcpOnce(
        reopened.database,
        command,
        args,
        () => {
          throw new Error('revoked');
        },
        dispatch,
      ),
    ).rejects.toThrow('revoked');
    await expect(
      executeDeviceMcpOnce(
        reopened.database,
        command,
        { text: 'changed' },
        () => {},
        dispatch,
      ),
    ).rejects.toThrow('identity conflict');
    reopened.database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted and invalid-result calls remain uncertain without repeating effects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-mcp-'));
  try {
    const state = openDeviceState(path.join(root, 'private/node.sqlite'));
    const { command, args } = binding();
    let resolve!: (value: {
      outcome: 'completed';
      content: string;
      content_digest: string;
    }) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<{
          outcome: 'completed';
          content: string;
          content_digest: string;
        }>((r) => {
          resolve = r;
        }),
    );
    const first = executeDeviceMcpOnce(
      state.database,
      command,
      args,
      () => {},
      dispatch,
    );
    expect(
      await executeDeviceMcpOnce(
        state.database,
        command,
        args,
        () => {},
        dispatch,
      ),
    ).toEqual({ outcome: 'uncertain', error_code: 'INTERRUPTED' });
    resolve({
      outcome: 'completed',
      content: 'ok',
      content_digest: 'b'.repeat(64),
    });
    expect(await first).toEqual({
      outcome: 'uncertain',
      error_code: 'INVALID_RESULT',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    state.database.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
