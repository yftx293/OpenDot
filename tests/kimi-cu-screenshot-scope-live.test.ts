import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { KimiCuBackend } from '../src/personal-agent/kimi-cu-backend.js';
import { normalizeScreenshotImage } from '../src/personal-agent/device-screenshot.js';
import { openKimiCuMcp } from './helpers/kimicu-mcp.js';

const pid = Number(process.env.OPENDOT_TEST_KIMICU_COLOR_PID);
const greenWindow = Number(process.env.OPENDOT_TEST_KIMICU_GREEN_WINDOW);
const redWindow = Number(process.env.OPENDOT_TEST_KIMICU_RED_WINDOW);
const { PNG } = createRequire(import.meta.url)('pngjs');

// Direct real-backend scope test only. The owner must start the synthetic
// two-window fixture and supply its exact process/window IDs. No user window
// or screenshot is written to disk. A skip is not device acceptance.
test.skipIf(
  process.platform !== 'darwin' || !pid || !greenWindow || !redWindow,
)(
  'KimiCU observation and screenshot of one selected synthetic window exclude the other',
  async () => {
    expect(greenWindow).not.toBe(redWindow);
    const mcp = openKimiCuMcp();
    try {
      const init = await mcp.call('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'opendot-screenshot-fence', version: '1' },
      });
      expect(init.error).toBeUndefined();
      mcp.notify('notifications/initialized');
      const client = {
        async callTool(name: string, args: Record<string, unknown>) {
          const r = await mcp.call('tools/call', { name, arguments: args });
          if (r.error) throw new Error('KimiCU call rejected');
          return r.result;
        },
      };
      const captured = async (windowId: number) => {
        const backend = new KimiCuBackend(client, {
          appId: 'net.opendot.kimi-screenshot-fixture',
          pid,
          windowId,
        });
        const observation = await backend.observe();
        const { image } = await backend.observeScreenshot();
        const normalized = normalizeScreenshotImage(
          Buffer.from(image.data, 'base64'),
          image.mimeType!,
        );
        const decoded = PNG.sync.read(normalized.bytes, { checkCRC: true });
        let green = 0,
          red = 0;
        for (let i = 0; i < decoded.data.length; i += 4) {
          const [r, g, b] = decoded.data.subarray(i, i + 3);
          if (g > 180 && r < 90 && b < 90) green++;
          if (r > 180 && g < 90 && b < 90) red++;
        }
        const pixels = decoded.width * decoded.height;
        return {
          text: observation.text,
          green: green / pixels,
          red: red / pixels,
        };
      };
      const green = await captured(greenWindow),
        red = await captured(redWindow);
      expect(green.text).toContain('OpenDot Green Fixture');
      expect(green.text).not.toContain('OpenDot Red Fixture');
      expect(red.text).toContain('OpenDot Red Fixture');
      expect(red.text).not.toContain('OpenDot Green Fixture');
      expect(green.green).toBeGreaterThan(0.4);
      expect(green.red).toBeLessThan(0.01);
      expect(red.red).toBeGreaterThan(0.4);
      expect(red.green).toBeLessThan(0.01);
    } finally {
      mcp.close();
    }
  },
  60000,
);
