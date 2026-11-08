import { expect, test } from 'vitest';
import { KimiCuBackend } from '../src/personal-agent/kimi-cu-backend.js';
import { openKimiCuMcp } from './helpers/kimicu-mcp.js';

const fixturePid = Number(process.env.OPENDOT_TEST_KIMICU_PID);
const fixtureWindow = Number(process.env.OPENDOT_TEST_KIMICU_WINDOW_ID);

test.skipIf(process.platform !== 'darwin' || !fixturePid || !fixtureWindow)(
  'real KimiCU rejects a different window and an old native snapshot',
  async () => {
    const mcp = openKimiCuMcp();
    try {
      const initialized = await mcp.call('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'opendot-kimicu-fence-fixture', version: '1' },
      });
      expect(initialized.error).toBeUndefined();
      mcp.notify('notifications/initialized');
      const client = {
        async callTool(name: string, args: Record<string, unknown>) {
          const result = await mcp.call('tools/call', {
            name,
            arguments: args,
          });
          if (result.error)
            throw new Error('KimiCU fixture operation rejected');
          return result.result;
        },
      };
      const scope = {
        appId: 'net.opendot.kimi-fixture',
        pid: fixturePid,
        windowId: fixtureWindow,
      };
      const backend = new KimiCuBackend(client, scope);
      const wrongWindow = new KimiCuBackend(client, {
        ...scope,
        windowId: 2147483647,
      });
      await expect(wrongWindow.observe()).rejects.toThrow();
      const old = await backend.observe();
      expect(old.text).toContain('Fixture ready');
      const match = /\[(\d+)\] AXButton \(Run fixture action\)/.exec(old.text);
      expect(match).not.toBeNull();
      const action = { action: 'click' as const, index: Number(match![1]) };
      const latest = await backend.observe();
      expect(latest.target.snapshotId).not.toBe(old.target.snapshotId);
      await backend.executeAtTarget({ target: latest.target, action });
      await expect(
        backend.executeAtTarget({ target: old.target, action }),
      ).rejects.toThrow();
      const after = await backend.observe();
      expect(after.text).toContain('Fixture action complete 1');
      expect(after.text).not.toContain('Fixture action complete 2');
    } finally {
      mcp.close();
    }
  },
  60000,
);
