import { describe, expect, test, vi } from 'vitest';
import { KimiCuBackend } from '../src/personal-agent/kimi-cu-backend.js';

const scope = { appId: 'net.opendot.fixture', pid: 123, windowId: 456 };
const snapshot = 'B0D74EEC-6B80-4259-94FB-9A686E6BD6ED';
const state = `AX snapshot_id=${snapshot}. Pass this ID\n- bundle_id: net.opendot.fixture\n- pid: 123\n- windows: 2 (tree scoped to primary; others via window_id)\n  - [main] window_id=999 AXStandardWindow "OTHER_PRIVATE_WINDOW"\n  - [primary] window_id=456 AXStandardWindow "Fixture"\n\n- [3] AXButton (Fixture)`;
const response = (text: string) => ({ content: [{ type: 'text', text }] });

describe('KimiCU native target adapter', () => {
  test('targets text submission to the observed native snapshot', async () => {
    const callTool = vi.fn().mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response('ok'));
    const adapter = new KimiCuBackend({ callTool }, scope);
    const observed = await adapter.observe();
    await adapter.executeAtTarget({ target: observed.target, action: { action: 'type_text', index: 3, text: 'synthetic query', clear: true, submit: true } });
    expect(callTool).toHaveBeenLastCalledWith('type_text', { app: scope.appId, pid: scope.pid, window_id: scope.windowId, snapshot_id: snapshot, index: 3, text: 'synthetic query', clear: true, submit: true, activate: false });
  });
  test('pins observation and native action to the owner-selected window', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(response(state))
      .mockResolvedValueOnce(response('ok'));
    const adapter = new KimiCuBackend({ callTool }, scope);
    const observed = await adapter.observe();
    expect(observed.text).not.toContain('OTHER_PRIVATE_WINDOW');
    expect(observed.text).not.toContain('window_id=999');
    await adapter.executeAtTarget({
      target: observed.target,
      action: { action: 'click', index: 3 },
    });
    expect(callTool).toHaveBeenNthCalledWith(1, 'get_window_state', {
      app: scope.appId,
      pid: 123,
      window_id: 456,
      include_text: true,
      include_screenshot: false,
    });
    expect(callTool).toHaveBeenNthCalledWith(2, 'click', {
      app: scope.appId,
      pid: 123,
      window_id: 456,
      snapshot_id: snapshot,
      index: 3,
      allow_foreground_fallback: false,
      verify_after: true,
    });
  });
  test('sets a value in the fixed window without submitting it', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce(response(state))
      .mockResolvedValueOnce(response('ok'));
    const adapter = new KimiCuBackend({ callTool }, scope);
    const observed = await adapter.observe();
    await adapter.executeAtTarget({
      target: observed.target,
      action: { action: 'set_value', index: 3, value: 'synthetic value' },
    });
    expect(callTool).toHaveBeenNthCalledWith(2, 'set_value', {
      app: scope.appId, pid: 123, window_id: 456,
      snapshot_id: snapshot, index: 3, value: 'synthetic value',
      autosubmit: false,
    });
  });
  test('refuses mismatched identity and a target from a different window before action', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue(response(state.replace('- pid: 123', '- pid: 999')));
    const adapter = new KimiCuBackend({ callTool }, scope);
    await expect(adapter.observe()).rejects.toThrow('identity mismatch');
    await expect(
      adapter.executeAtTarget({
        target: { ...scope, windowId: 999, snapshotId: snapshot },
        action: { action: 'click', index: 3 },
      }),
    ).rejects.toThrow('target mismatch');
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  test('rejects malformed native snapshot IDs before any action', async () => {
    const malformed = '------------------------------------';
    const callTool = vi
      .fn()
      .mockResolvedValue(response(state.replace(snapshot, malformed)));
    const adapter = new KimiCuBackend({ callTool }, scope);
    await expect(adapter.observe()).rejects.toThrow('identity mismatch');
    await expect(
      adapter.executeAtTarget({
        target: { ...scope, snapshotId: malformed },
        action: { action: 'click', index: 3 },
      }),
    ).rejects.toThrow('target mismatch');
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  test('rejects a window directory rather than exposing other window titles', async () => {
    const callTool = vi.fn().mockResolvedValue(
      response(state + '\nwindows:\n- id: 999 title: OTHER_PRIVATE_WINDOW'),
    );
    const adapter = new KimiCuBackend({ callTool }, scope);
    await expect(adapter.observe()).rejects.toThrow('window directory');
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  test('rejects an incorrect or malformed native primary window', async () => {
    const callTool = vi.fn().mockResolvedValueOnce(response(state.replace('window_id=456', 'window_id=777')))
      .mockResolvedValueOnce(response(state.replace('  - [main] window_id=999', '  - malformed window_id=999')));
    const adapter = new KimiCuBackend({ callTool }, scope);
    await expect(adapter.observe()).rejects.toThrow('window identity mismatch');
    await expect(adapter.observe()).rejects.toThrow('window directory invalid');
  });
  test('rejects errors and unexpected image content', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'image' }] });
    await expect(
      new KimiCuBackend({ callTool }, scope).observe(),
    ).rejects.toThrow('unavailable');
  });
});

test('captures exactly one image from the fixed window and rejects other image shapes', async () => {
  const image = {
    type: 'image',
    mimeType: 'image/jpeg',
    data: Buffer.from('synthetic').toString('base64'),
  };
  const callTool = vi
    .fn()
    .mockResolvedValue({ content: [{ type: 'text', text: state }, image] });
  const adapter = new KimiCuBackend({ callTool }, scope);
  const result = await adapter.observeScreenshot();
  expect(result.image).toEqual(image);
  expect(callTool).toHaveBeenCalledWith('get_window_state', {
    app: scope.appId,
    pid: 123,
    window_id: 456,
    include_text: true,
    include_screenshot: true,
  });
  callTool.mockResolvedValueOnce({
    content: [{ type: 'text', text: state }, image, image],
  });
  await expect(adapter.observeScreenshot()).rejects.toThrow('unavailable');
  callTool.mockResolvedValueOnce({
    content: [
      { type: 'text', text: state },
      { ...image, data: 'not-base64!' },
    ],
  });
  await expect(adapter.observeScreenshot()).rejects.toThrow(
    'image unavailable',
  );
  callTool.mockResolvedValueOnce({
    content: [
      { type: 'text', text: state + '\nScreenshot: window_id=999, screenshot_id=fixture' },
      image,
    ],
  });
  await expect(adapter.observeScreenshot()).rejects.toThrow('screenshot window mismatch');
});
