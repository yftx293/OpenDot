import { expect, test } from 'vitest';
import {
  decideMainConversationRoute,
  durableMainFlagsEnabled,
} from '../src/personal-agent/durable-main.js';
import {
  durableNoticeText,
  durableRestartPlan,
  resolveDurableNoticeJid,
} from '../src/personal-agent/durable-im-notice.js';
import {
  CLOUD_MODEL_STEP_CEILING,
  cloudModelStepLimit,
} from '../src/personal-agent/cloud-model-steps.js';

const isIm = (jid: string) =>
  jid.startsWith('feishu:') || jid.startsWith('telegram:');

test('main chat stays on the coding agent unless the durable main flag is on and the transcript is empty', () => {
  expect(durableMainFlagsEnabled({})).toBe(false);
  expect(
    durableMainFlagsEnabled({
      MINICLAW_DURABLE_RUNTIME: 'true',
      MINICLAW_DURABLE_MAIN: 'true',
    }),
  ).toBe(true);
  expect(
    decideMainConversationRoute({
      flagsEnabled: false,
      executionMode: 'host',
      hasAssistantHistory: false,
      durableMainExists: false,
      hasAttachments: false,
      isClear: false,
    }),
  ).toBe('passthrough');
  expect(
    decideMainConversationRoute({
      flagsEnabled: true,
      executionMode: 'container',
      hasAssistantHistory: false,
      durableMainExists: false,
      hasAttachments: false,
      isClear: false,
    }),
  ).toBe('passthrough');
  expect(
    decideMainConversationRoute({
      flagsEnabled: true,
      executionMode: 'host',
      hasAssistantHistory: true,
      durableMainExists: false,
      hasAttachments: false,
      isClear: false,
    }),
  ).toBe('passthrough');
  expect(
    decideMainConversationRoute({
      flagsEnabled: true,
      executionMode: 'host',
      hasAssistantHistory: false,
      durableMainExists: false,
      hasAttachments: true,
      isClear: false,
    }),
  ).toBe('passthrough');
  expect(
    decideMainConversationRoute({
      flagsEnabled: true,
      executionMode: 'host',
      hasAssistantHistory: false,
      durableMainExists: false,
      hasAttachments: false,
      isClear: false,
    }),
  ).toBe('route');
  expect(
    decideMainConversationRoute({
      flagsEnabled: true,
      executionMode: 'host',
      hasAssistantHistory: true,
      durableMainExists: true,
      hasAttachments: false,
      isClear: false,
    }),
  ).toBe('route');
});

test('durable notices prefer the originating IM channel and are not duplicated by guessing', () => {
  expect(
    resolveDurableNoticeJid({
      originSourceJid: 'feishu:oc_1',
      sessionChannelOwner: 'telegram:2',
      mountedChannelJids: ['feishu:oc_9'],
      isIm,
    }),
  ).toBe('feishu:oc_1');
  expect(
    resolveDurableNoticeJid({
      originSourceJid: 'web:home',
      sessionChannelOwner: 'feishu:oc_1',
      isIm,
    }),
  ).toBe('feishu:oc_1');
  expect(
    resolveDurableNoticeJid({
      mountedChannelJids: ['feishu:oc_1', 'telegram:2'],
      isIm,
    }),
  ).toBeNull();
  expect(
    resolveDurableNoticeJid({
      mountedChannelJids: ['feishu:only'],
      isIm,
    }),
  ).toBe('feishu:only');
  expect(durableNoticeText('complete', 'Chief')).toContain('Dot');
  expect(durableNoticeText('approval', 'Mini')).toContain('确认');
});

test('restart resumes a node durable session and does not fail a blocked one', () => {
  expect(
    durableRestartPlan({
      state: 'ready',
      cloud: false,
      goal: false,
      groupIdle: false,
      handoffTerminal: false,
    }),
  ).toBe('resume');
  expect(
    durableRestartPlan({
      state: 'ready',
      cloud: true,
      goal: false,
      groupIdle: false,
      handoffTerminal: false,
    }),
  ).toBe('skip');
  expect(
    durableRestartPlan({
      state: 'blocked',
      cloud: false,
      goal: false,
      groupIdle: false,
      handoffTerminal: false,
    }),
  ).toBe('leave-blocked');
});

test('cloud model step limit stays 24 unless an operator raises it within the ceiling', () => {
  expect(cloudModelStepLimit({})).toBe(24);
  expect(cloudModelStepLimit({ MINICLAW_CLOUD_MAX_MODEL_STEPS: '48' })).toBe(
    48,
  );
  expect(cloudModelStepLimit({ MINICLAW_CLOUD_MAX_MODEL_STEPS: '99' })).toBe(
    24,
  );
  expect(CLOUD_MODEL_STEP_CEILING).toBe(64);
});
