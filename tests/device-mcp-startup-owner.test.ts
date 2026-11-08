import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { withDeviceMcpStartupCandidate } from '../src/personal-agent/device-mcp-startup-owner.js';
import {
  executeDeviceMcpStartupOnce,
  openDeviceState,
} from '../src/personal-agent/device-local.js';

function candidateProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  return {
    child,
    exited,
    async close() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      await exited;
    },
  };
}

test('startup authorization failure closes an unadopted process', async () => {
  const candidate = candidateProcess();
  await expect(
    withDeviceMcpStartupCandidate(
      candidate,
      () => false,
      async () => {
        throw new Error('authority revoked after startup');
      },
    ),
  ).rejects.toThrow('authority revoked after startup');
  expect(candidate.child.signalCode).toBe('SIGTERM');
});

test('an existing registry entry does not retain a different candidate', async () => {
  const existing = candidateProcess();
  const candidate = candidateProcess();
  try {
    await withDeviceMcpStartupCandidate(
      candidate,
      () => existing === candidate,
      async () => 'replayed',
    );
    expect(candidate.child.signalCode).toBe('SIGTERM');
    expect(existing.child.signalCode).toBeNull();
  } finally {
    await existing.close();
  }
});

test('an adopted connection stays alive for the subsequent tool call', async () => {
  const candidate = candidateProcess();
  try {
    const result = await withDeviceMcpStartupCandidate(
      candidate,
      () => true,
      async () => 'ready',
    );
    expect(result).toBe('ready');
    expect(candidate.child.signalCode).toBeNull();
  } finally {
    await candidate.close();
  }
});

test('revocation after device startup records uncertainty and closes the candidate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-startup-revoke-'));
  const state = openDeviceState(path.join(root, 'private/node.sqlite'));
  const candidate = candidateProcess();
  const id = randomUUID();
  let authorized = true;
  const binding = {
    version: 2 as const,
    capability: 'mcp.start' as const,
    id,
    consent_id: id,
    owner_id: 'owner',
    workspace_jid: 'web:home',
    session_id: randomUUID(),
    dot_id: randomUUID(),
    node_id: randomUUID(),
    device_grant_id: randomUUID(),
    manifest_hash: 'a'.repeat(64),
    configuration_digest: 'b'.repeat(64),
    declaration_digest: 'c'.repeat(64),
    server_id: 'browser',
    tools: ['read'],
    expires_at: Date.now() + 60_000,
  };
  try {
    await expect(
      withDeviceMcpStartupCandidate(
        candidate,
        () => false,
        () =>
          executeDeviceMcpStartupOnce(
            state.database,
            binding,
            () => {
              if (!authorized) throw new Error('revoked');
            },
            () => false,
            async () => {
              authorized = false;
              throw new Error('authority revoked after process startup');
            },
          ),
      ),
    ).rejects.toThrow('revoked');
    expect(candidate.child.signalCode).toBe('SIGTERM');
    const receipt = state.database
      .prepare('SELECT state, result FROM mcp_receipts WHERE id=?')
      .get(id) as { state: string; result: string };
    expect(receipt.state).toBe('settled');
    expect(JSON.parse(receipt.result)).toMatchObject({ outcome: 'uncertain' });
  } finally {
    if (
      candidate.child.exitCode === null &&
      candidate.child.signalCode === null
    )
      await candidate.close();
    state.database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
