import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  buildMcpCatalog,
  indexMcpCatalog,
  McpCallIntentSchema,
  mcpCanonicalJson,
  mcpDigest,
  PiMcpPolicySchema,
  selectGrantedMcpTools,
} from '../src/mcp-contract.js';

const tool = (name = 'read', extra = {}) => ({
  name,
  inputSchema: { type: 'object', properties: {} },
  ...extra,
});
const catalog = (
  listed = [tool()],
  selected = ['read'],
  serverId = 'fixture',
) =>
  buildMcpCatalog({
    ownerId: 'owner',
    serverId,
    serverConfigDigest: 'c'.repeat(64),
    location: { kind: 'host' },
    listed,
    selected,
  });

test('catalog identity is stable across JSON ordering and distinct across scope/schema/location', () => {
  const first = catalog();
  expect(
    catalog([
      { inputSchema: { properties: {}, type: 'object' }, name: 'read' },
    ]),
  ).toEqual(first);
  expect(
    catalog([tool('read', { annotations: { readOnlyHint: true } })])[0].identity
      .catalog_digest,
  ).not.toBe(first[0].identity.catalog_digest);
  expect(
    catalog([
      tool('read', { inputSchema: { type: 'object', required: ['path'] } }),
    ])[0].identity.schema_digest,
  ).not.toBe(first[0].identity.schema_digest);
  expect(
    buildMcpCatalog({
      ownerId: 'other',
      serverId: 'fixture',
      serverConfigDigest: 'c'.repeat(64),
      location: { kind: 'device', node_id: randomUUID() },
      listed: [tool()],
      selected: ['read'],
    })[0].identity,
  ).not.toEqual(first[0].identity);
  expect(first[0].identity.registered_name).toBe('mcp__fixture__read');
});

test('missing, duplicate, normalized and cross-server alias collisions are rejected', () => {
  expect(() => catalog([tool()], ['missing'])).toThrow(/absent/);
  expect(() => catalog([tool(), tool()])).toThrow(/Duplicate/);
  expect(() => catalog([tool()], ['read', 'read'])).toThrow(/Duplicate/);
  expect(() => catalog([tool('a.b'), tool('a_b')], ['a.b', 'a_b'])).toThrow(
    /collision/,
  );
  expect(() =>
    indexMcpCatalog([
      ...catalog([tool('b__c')], ['b__c'], 'a'),
      ...catalog([tool('c')], ['c'], 'a__b'),
    ]),
  ).toThrow(/collision/);
  const long = catalog([tool('x'.repeat(200))], ['x'.repeat(200)])[0];
  expect(long.identity.registered_name).toHaveLength(64);
  expect(indexMcpCatalog([long]).get(`mcp__fixture__${'x'.repeat(200)}`)).toBe(
    long,
  );
});

test('profile catalog is intersected with each run grant; internal wildcard grants no MCP', () => {
  const entries = catalog([tool('read'), tool('write')], ['read', 'write']);
  expect(selectGrantedMcpTools(entries, ['mcp__miniclaw__*'])).toEqual([]);
  expect(selectGrantedMcpTools(entries, ['mcp__fixture__read'])).toEqual([
    entries[0],
  ]);
  expect(selectGrantedMcpTools(entries, [])).toEqual([]);
  expect(() => selectGrantedMcpTools(entries, ['mcp__fixture__*'])).toThrow(
    /Unknown/,
  );
});

test('policy is explicit and versioned; unknown configuration cannot grant capabilities', () => {
  const policy = {
    version: 1,
    enabled: true,
    location: { kind: 'host' },
    tools: ['read'],
  };
  expect(PiMcpPolicySchema.parse(policy)).toEqual(policy);
  for (const invalid of [
    undefined,
    { ...policy, version: 2 },
    { ...policy, allowAll: true },
    { ...policy, location: { kind: 'cloud' } },
    { ...policy, tools: ['read', 'read'] },
  ])
    expect(PiMcpPolicySchema.safeParse(invalid).success).toBe(false);
});

test('canonical digests reject lossy JSON values, deep recursion and oversized payloads', () => {
  expect(mcpDigest({ z: 1, a: 2 })).toBe(mcpDigest({ a: 2, z: 1 }));
  for (const value of [
    undefined,
    { a: undefined },
    NaN,
    Infinity,
    new Date(),
    'x'.repeat(262145),
  ])
    expect(() => mcpCanonicalJson(value)).toThrow();
  let deep: unknown = {};
  for (let i = 0; i < 34; i++) deep = { deep };
  expect(() => mcpCanonicalJson(deep)).toThrow(/depth/);
});

test('Coding provenance cannot masquerade as a positive Durable ToolTask', () => {
  const identity = catalog()[0].identity;
  const intent = {
    ...identity,
    operation: 'mcp.call',
    call_id: randomUUID(),
    dot_id: randomUUID(),
    workspace_jid: 'web:fixture',
    session_id: randomUUID(),
    arguments_digest: mcpDigest({}),
    grant_id: randomUUID(),
    grant_revision: 1,
    cancel_generation: 0,
    expires_at: Date.now() + 1000,
    source: {
      runtime: 'pi-coding-agent',
      conversation_id: randomUUID(),
      business_turn_id: 'turn:1',
      tool_call_id: 'tool:1',
    },
  };
  expect(McpCallIntentSchema.parse(intent).source.runtime).toBe(
    'pi-coding-agent',
  );
  expect(
    McpCallIntentSchema.safeParse({
      ...intent,
      source: { ...intent.source, tool_task_id: 1 },
    }).success,
  ).toBe(false);
  expect(
    McpCallIntentSchema.safeParse({
      ...intent,
      source: {
        runtime: 'pi-durable',
        conversation_id: 1,
        tool_task_id: 'tool:1',
        generation_task_id: 2,
        call_id: 'tool:1',
        inputs: [],
      },
    }).success,
  ).toBe(false);
});
