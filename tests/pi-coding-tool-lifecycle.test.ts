import { expect, test } from 'vitest';
import { mapPiEvent } from '../container/agent-runner/src/runtime/pi/pi-session.js';
import { toStreamEvent } from '../container/agent-runner/src/runtime/pi/pi-runner.js';

const event = (value: unknown) => value as Parameters<typeof mapPiEvent>[0];

test('model tool-call deltas do not announce tool execution or completion', () => {
  const toolCall = {
    type: 'toolCall',
    id: 'call-1',
    name: 'Task',
    arguments: {},
  };
  expect(
    mapPiEvent(
      event({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          partial: { content: [toolCall] },
        },
      }),
      'session',
    ),
  ).toBeUndefined();
  expect(
    mapPiEvent(
      event({
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_end', toolCall },
      }),
      'session',
    ),
  ).toBeUndefined();
});

test('actual tool execution carries its identity and failure outcome', () => {
  expect(
    mapPiEvent(
      event({
        type: 'tool_execution_start',
        toolName: 'Task',
        toolCallId: 'call-1',
        args: {},
      }),
      'session',
    ),
  ).toMatchObject({
    type: 'tool_start',
    sessionId: 'session',
    toolCallId: 'call-1',
  });
  expect(
    mapPiEvent(
      event({
        type: 'tool_execution_end',
        toolName: 'Task',
        toolCallId: 'call-1',
        result: { content: [] },
        isError: true,
      }),
      'session',
    ),
  ).toMatchObject({
    type: 'tool_end',
    sessionId: 'session',
    toolCallId: 'call-1',
    isError: true,
  });
});

test('execution failure survives the runner stream boundary', () => {
  const result = toStreamEvent(
    {
      type: 'tool_end',
      sessionId: 'session',
      toolName: 'Task',
      toolCallId: 'call-1',
      isError: true,
    },
    {} as Parameters<typeof toStreamEvent>[1],
  );
  expect(result).toMatchObject({
    eventType: 'tool_use_end',
    toolUseId: 'call-1',
    toolIsError: true,
  });
});
