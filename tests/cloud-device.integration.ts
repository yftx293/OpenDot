// Actual compiled Node + workerd SQLite + existing Device Node file reader.
// Only model inference and the test HTTPS-to-loopback route are simulated.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { cloudBotHandoffHttpFixture } from './helpers/cloud-bot-handoff-http-fixture.js';
import { waitFor } from './helpers/bot-handoff-http-fixture.js';
import {
  createDeviceReader,
  openDeviceState,
  cachedDeviceRead,
} from '../src/personal-agent/device-local.js';
import {
  deviceTextDigest,
  deviceDigest,
} from '../src/personal-agent/device-protocol.js';
import type { PersonalGoal } from '../src/personal-agent/goal-store.js';
import type { CloudDeviceIdentity } from '../src/personal-agent/cloud-device-wire.js';
import type { ProductApproval } from '../src/personal-agent/approval-store.js';

test('Cloud Team waits for an exact local file grant and resumes its original native Tool Task after workerd reconstruction (model simulated)', async () => {
  const f = await cloudBotHandoffHttpFixture({
    goalTeams: true,
    deviceNodes: true,
    memberInbox: true,
  });
  const local = path.join(f.root, 'finite-project');
  fs.mkdirSync(local);
  const content = 'LOCAL_CLOUD_EVIDENCE_' + randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(local, 'research.txt'), content);
  const state = openDeviceState(path.join(f.root, 'node-private/node.sqlite'));
  const reader = createDeviceReader(local, ['research.txt'], state.filename);
  const token = randomBytes(32).toString('hex');
  let storage: Database.Database | undefined;
  let stage = 'pair';
  try {
    const { ticket } = await f.json<{ ticket: { pair_code: string } }>(
      await f.call('/api/device-nodes/pair-tickets', 'POST', {
        name: 'Finite project',
      }),
    );
    const transport = async (endpoint: string, body?: unknown) =>
      fetch(f.origin + '/api/device-nodes/transport/' + endpoint, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const { device: joined } = await f.json<{
      device: { id: string; revision: number };
    }>(
      await fetch(f.origin + '/api/device-nodes/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair_code: ticket.pair_code,
          claim_request_id: randomUUID(),
          token_hash: deviceTextDigest(token),
          manifest: reader.manifest,
        }),
      }),
    );
    const { device } = await f.json<{
      device: { id: string; revision: number };
    }>(
      await f.call(`/api/device-nodes/${joined.id}/approve`, 'POST', {
        expected_revision: joined.revision,
        confirmed: true,
      }),
    );
    const team = await f.createGroup(
      ['read_device_file', 'create_approved_artifact'],
      4,
      'cloudflare-durable',
    );
    // The same Group has two otherwise eligible discussion participants before
    // Goal admission. This tests the device boundary, not a one-member failure.
    const peer = await f.json<{ profile: { id: string } }>(
      await f.call('/api/agent-profiles/quick-create', 'POST', {
        request_id: randomUUID(),
        name: 'Public Reviewer',
        avatar_shape: 'blob',
        avatar_color: '#1456f0',
      }),
    );
    const beforePeer = await f.snapshot(team.groupId);
    const cloudProfile = beforePeer.members.find(
      (member) => member.id === team.memberId,
    )!.subject_id;
    await f.json(
      await f.call(`/api/bot-groups/${team.groupId}/members`, 'POST', {
        kind: 'bot',
        profile_id: peer.profile.id,
        expected_revision: beforePeer.revision,
      }),
    );
    storage = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const currentCloudGrant = () =>
      storage!
        .prepare(
          'SELECT id,member_id,runtime_kind,tool_capabilities,revoked_at FROM bot_group_runtime_grants WHERE member_id=? AND revoked_at IS NULL',
        )
        .get(team.memberId);
    let readReceived = '';
    f.setModel((body) => {
      const results = body.messages.filter((m) => m.role === 'tool');
      if (!results.length)
        return {
          tool: {
            name: 'read_device_file',
            arguments: { node_id: device.id, path: 'research.txt' },
          },
        };
      if (results.length === 1) {
        readReceived = JSON.stringify(results[0]);
        return {
          tool: {
            name: 'create_approved_artifact',
            arguments: {
              content: readReceived.includes(content)
                ? 'Verified ' + content
                : 'MISSING_LOCAL_FILE',
            },
          },
        };
      }
      return { text: 'Local inspection complete with approved evidence.' };
    });
    stage = 'goal';
    const { goal } = await f.json<{ goal: PersonalGoal }>(
      await f.call('/api/goals', 'POST', {
        workspace_jid: team.workspaceJid,
        objective: 'Inspect the explicitly declared local research file',
        completion_criteria: ['artifact_contains:' + content],
        next_action:
          'Read the requested device file and deliver an approved report',
        budget_max_runs: 1,
        runtime: 'cloudflare-durable',
        team: { group_id: team.groupId, bot_member_ids: [team.memberId] },
      }),
    );
    type Request = {
      identity: CloudDeviceIdentity;
      tool_task_id: number;
      state: string;
    };
    const requests = async () =>
      (
        await f.json<{ requests: Request[] }>(
          await f.call('/api/device-nodes/requests'),
        )
      ).requests;
    const detail = async () =>
      (
        await f.json<{ goal: PersonalGoal }>(
          await f.call('/api/goals/' + goal.id),
        )
      ).goal;
    stage = 'permission wait';
    await waitFor(
      async () =>
        (await requests()).length === 1 &&
        (await detail()).status === 'waiting_for_approval',
    );
    const original = (await f.snapshot(team.groupId)).handoffs![0],
      request = (await requests())[0];
    expect(request.state).toBe('waiting_for_permission');
    expect(f.requests).toHaveLength(1);
    expect(await f.json(await transport('commands'))).toEqual({
      command: null,
    });
    stage = 'workerd reconstruction';
    await f.restartWorker();
    stage = 'grant';
    const key = randomUUID(),
      grantInput = {
        confirmed: true,
        workspace_jid: team.workspaceJid,
        capability: 'files.read',
        paths: ['research.txt'],
        expected_revision: device.revision,
        ttl_seconds: 3600,
        cloud_request_id: request.identity.request_id,
      };
    const first = await f.json<{ grant: { id: string } }>(
      await f.call(
        `/api/device-nodes/${device.id}/grants`,
        'POST',
        grantInput,
        key,
      ),
    );
    expect(
      await f.json(
        await f.call(
          `/api/device-nodes/${device.id}/grants`,
          'POST',
          grantInput,
          key,
        ),
      ),
    ).toEqual(first);
    stage = 'offline wait';
    await waitFor(
      async () =>
        (await requests())[0]?.state === 'waiting_for_device' &&
        (await detail()).status === 'waiting_for_device',
    );
    expect(f.requests).toHaveLength(1);
    stage = 'offline Goal versus member discussion admission';
    const devices = await f.json<{
      devices: {
        id: string;
        state: string;
        online: boolean;
        last_seen_at: string | null;
      }[];
    }>(await f.call('/api/device-nodes'));
    const offline = devices.devices.find((item) => item.id === device.id)!;
    expect(offline).toMatchObject({
      state: 'active',
      online: false,
      last_seen_at: null,
    });
    const beforeMember = await f.snapshot(team.groupId);
    const originalGrant = currentCloudGrant();
    const nativeInputIdentities = () =>
      storage!
        .prepare(
          'SELECT id,session_id,request_id,submission_id,payload_digest FROM product_session_inputs ORDER BY id',
        )
        .all();
    const inputsBeforeMember = nativeInputIdentities();
    expect(inputsBeforeMember).toHaveLength(1);
    const blocked = await f.call(
      `/api/bot-groups/${team.groupId}/discussion-settings`,
      'PATCH',
      {
        enabled: true,
        execution_contract: 'member-inbox-v1',
        policy: 'relay-v1',
        coordinator_profile_id: cloudProfile,
        participant_profile_ids: [cloudProfile, peer.profile.id],
        expected_revision: beforeMember.revision,
      },
    );
    expect(blocked.status).toBe(409);
    const denied = (await blocked.json()) as { code: string; error: string };
    expect(denied.code).toBe('GROUP_DISCUSSION_DEVICE_REQUIRES_GOAL');
    expect(denied.error).toContain('设备');
    expect(denied.error).toContain('工作');
    const afterMember = await f.snapshot(team.groupId);
    expect(afterMember.revision).toBe(beforeMember.revision);
    expect(afterMember.discussion).toEqual(beforeMember.discussion);
    const grantAfterMember = currentCloudGrant();
    expect(grantAfterMember).toEqual(originalGrant);
    expect((await detail()).status).toBe('waiting_for_device');
    expect((await requests())[0]).toMatchObject({
      identity: request.identity,
      tool_task_id: request.tool_task_id,
      state: 'waiting_for_device',
    });
    expect(await f.json(await transport('commands'))).toEqual({
      command: null,
    });
    const inputsAfterMember = nativeInputIdentities();
    expect(inputsAfterMember).toEqual(inputsBeforeMember);
    for (const table of [
      'bot_group_discussions',
      'bot_group_member_leases',
      'bot_group_dot_sessions',
    ])
      expect(storage.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({
        n: 0,
      });
    expect(f.requests).toHaveLength(1);
    expect(f.submissions).toHaveLength(1);
    stage = 'online';
    await f.json(
      await transport('heartbeat', {
        manifest_hash: deviceTextDigest(JSON.stringify(reader.manifest)),
        ready: true,
      }),
    );
    type Command = {
      id: string;
      lease_id: string;
      params_digest: string;
      path: string;
    };
    let command: Command | undefined;
    await waitFor(async () => {
      const value = await f.json<{ command: Command | null }>(
        await transport('commands'),
      );
      if (value.command) command = value.command;
      return !!command;
    });
    expect(command!.id).toBe(request.identity.request_id);
    expect(command!.path).toBe('research.txt');
    const localCommand = { ...command!, path: 'research.txt' };
    const result = cachedDeviceRead(state.database, localCommand, reader.read);
    expect(result).toEqual({
      ok: true,
      content,
      content_digest: deviceTextDigest(content),
    });
    fs.writeFileSync(
      path.join(local, 'research.txt'),
      'CHANGED_AFTER_FIRST_READ',
    );
    expect(cachedDeviceRead(state.database, localCommand, reader.read)).toEqual(
      result,
    );
    stage = 'lost Cloud checkpoint confirmation ACK';
    f.loseNextDeviceConfirmationAck();
    const payload = {
      command_id: command!.id,
      lease_id: command!.lease_id,
      params_digest: command!.params_digest,
      result,
    };
    const receipt = await f.json(await transport('result', payload));
    expect(await f.json(await transport('result', payload))).toEqual(receipt);
    await waitFor(() => f.deviceConfirmationLosses() === 1);
    await f.restartWorker();
    stage = 'artifact approval';
    let approvals: ProductApproval[] = [];
    await waitFor(async () => {
      approvals = (
        await f.json<{ approvals: ProductApproval[] }>(
          await f.call(
            `/api/bot-groups/${team.groupId}/handoffs/${original.id}/approvals`,
          ),
        )
      ).approvals;
      return approvals.length === 1;
    });
    expect(readReceived).toContain(content);
    await f.json(
      await f.call(
        `/api/bot-groups/${team.groupId}/handoffs/${original.id}/approvals/${approvals[0].id}`,
        'POST',
        {
          decision: 'approve',
          parameters_digest: approvals[0].parameters_digest,
        },
      ),
    );
    stage = 'completion';
    await waitFor(async () => (await detail()).status === 'completed');
    const final = (await f.snapshot(team.groupId)).handoffs!;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      id: original.id,
      submission_id: original.submission_id,
      input_id: original.input_id,
      state: 'completed',
    });
    expect(f.requests).toHaveLength(3);
    expect(f.submissions).toHaveLength(1);
    const evidence = await f.json<{
      device_evidence: {
        request_id: string;
        tool_task_id: number;
        verified: boolean;
        result_digest: string;
      }[];
    }>(await f.call('/api/goals/' + goal.id));
    expect(evidence.device_evidence).toMatchObject([
      {
        request_id: request.identity.request_id,
        tool_task_id: request.tool_task_id,
        verified: true,
        result_digest: deviceDigest(result),
      },
    ]);
    expect(JSON.stringify(evidence.device_evidence)).not.toContain(content);
    const proofDir = process.env.MINICLAW_MEMBER_PROOF_DIR;
    if (proofDir) {
      fs.mkdirSync(proofDir, { recursive: true, mode: 0o700 });
      const hash = (value: string | Buffer) =>
        createHash('sha256').update(value).digest('hex');
      fs.writeFileSync(
        path.join(proofDir, 'goal-device-offline-member-boundary.json'),
        JSON.stringify(
          {
            scenario: 'goal-device-offline-member-boundary',
            inference: 'synthetic-loopback',
            runtime: 'actual-node-product-and-local-workerd-pi-harness',
            source_sha256: Object.fromEntries(
              [
                'tests/cloud-device.integration.ts',
                'src/bot-groups/discussion-store.ts',
                'src/bot-groups/errors.ts',
                'src/personal-agent/cloud-device-store.ts',
                'src/personal-agent/cloud-device-evidence.ts',
                'apps/cloud-agent/src/device-tool.ts',
                'tests/helpers/cloud-bot-handoff-http-fixture.ts',
              ].map((file) => [
                file,
                hash(fs.readFileSync(new URL('../' + file, import.meta.url))),
              ]),
            ),
            offline_device: {
              id: offline.id,
              state: offline.state,
              online: offline.online,
              last_seen_at: offline.last_seen_at,
            },
            blocked_member_admission: {
              status: blocked.status,
              ...denied,
              revision_before: beforeMember.revision,
              revision_after: afterMember.revision,
              no_discussion_or_member_leases: true,
              no_extra_provider_or_native_submission: true,
              grant_before: originalGrant,
              grant_after: grantAfterMember,
              native_inputs_before: inputsBeforeMember,
              native_inputs_after: inputsAfterMember,
            },
            original_device_request: request,
            original_handoff: {
              id: original.id,
              input_id: original.input_id,
              submission_id: original.submission_id,
            },
            completed_handoff: {
              id: final[0].id,
              input_id: final[0].input_id,
              submission_id: final[0].submission_id,
              state: final[0].state,
            },
            completed_goal: { id: goal.id, status: (await detail()).status },
            native_inputs: storage
              .prepare(
                'SELECT id,session_id,request_id,submission_id,state,payload_digest FROM product_session_inputs ORDER BY id',
              )
              .all(),
            device_evidence: evidence.device_evidence,
            file_content_sha256: hash(content),
            provider_calls: f.requests.length,
            provider_inputs: f.requests.map((body) => ({
              messages_sha256: hash(JSON.stringify(body.messages)),
              tools: body.tools?.map((tool) => tool.function.name),
            })),
            scope:
              'The authorized Goal resumes its original device Tool Task. Direct member-device execution is rejected, not implemented by this test.',
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
    }
  } catch (error) {
    throw new Error(
      `Cloud device stage ${stage}: ${String(error)}\n${f.diagnostics()}`,
      { cause: error },
    );
  } finally {
    storage?.close();
    state.database.close();
    await f.dispose();
  }
}, 90000);

test('pause/cancel and a revoked device fence an original Cloud request after reconstruction, with no alternate execution (model simulated)', async () => {
  const f = await cloudBotHandoffHttpFixture({
    goalTeams: true,
    deviceNodes: true,
  });
  try {
    const { ticket } = await f.json<{ ticket: { pair_code: string } }>(
      await f.call('/api/device-nodes/pair-tickets', 'POST', {
        name: 'Revocable finite file node',
      }),
    );
    const { device: joined } = await f.json<{
      device: { id: string; revision: number };
    }>(
      await fetch(f.origin + '/api/device-nodes/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair_code: ticket.pair_code,
          claim_request_id: randomUUID(),
          token_hash: deviceTextDigest(randomUUID()),
          manifest: {
            version: 1,
            capability: 'files.read',
            root_label: 'Reviewed',
            root_fingerprint: 'a'.repeat(64),
            paths: ['research.txt'],
          },
        }),
      }),
    );
    const { device } = await f.json<{
      device: { id: string; revision: number };
    }>(
      await f.call(`/api/device-nodes/${joined.id}/approve`, 'POST', {
        confirmed: true,
        expected_revision: joined.revision,
      }),
    );
    const team = await f.createGroup(
      ['read_device_file', 'create_approved_artifact'],
      4,
      'cloudflare-durable',
    );
    f.setModel(() => ({
      tool: {
        name: 'read_device_file',
        arguments: { node_id: device.id, path: 'research.txt' },
      },
    }));
    const { goal } = await f.json<{ goal: PersonalGoal }>(
      await f.call('/api/goals', 'POST', {
        workspace_jid: team.workspaceJid,
        objective: 'Read one finite local file with separate permission',
        completion_criteria: ['artifact_contains:reviewed'],
        budget_max_runs: 1,
        runtime: 'cloudflare-durable',
        team: { group_id: team.groupId, bot_member_ids: [team.memberId] },
      }),
    );
    let request: CloudDeviceIdentity | undefined;
    await waitFor(async () => {
      const { requests } = await f.json<{
        requests: { identity: CloudDeviceIdentity }[];
      }>(await f.call('/api/device-nodes/requests'));
      request = requests[0]?.identity;
      return !!request;
    });
    const detail = async () =>
      (
        await f.json<{ goal: PersonalGoal }>(
          await f.call('/api/goals/' + goal.id),
        )
      ).goal;
    const grant = {
      confirmed: true,
      workspace_jid: team.workspaceJid,
      capability: 'files.read',
      paths: ['research.txt'],
      expected_revision: device.revision,
      cloud_request_id: request!.request_id,
    };
    await waitFor(
      async () => (await detail()).status === 'waiting_for_approval',
    );
    const before = (await f.snapshot(team.groupId)).handoffs![0];
    await f.json(
      await f.call('/api/goals/' + goal.id, 'PATCH', {
        expected_revision: (await detail()).revision,
        status: 'paused',
      }),
    );
    expect(
      (await f.call(`/api/device-nodes/${device.id}/grants`, 'POST', grant))
        .status,
    ).toBe(409);
    await f.restartWorker();
    await f.json(
      await f.call(`/api/device-nodes/${device.id}/revoke`, 'POST', {
        expected_revision: device.revision,
        confirmed: true,
      }),
    );
    expect(
      (await f.call(`/api/device-nodes/${device.id}/grants`, 'POST', grant))
        .status,
    ).toBe(409);
    await f.json(
      await f.call('/api/goals/' + goal.id, 'PATCH', {
        expected_revision: (await detail()).revision,
        status: 'cancelled',
      }),
    );
    await waitFor(async () => (await detail()).status === 'cancelled');
    const after = (await f.snapshot(team.groupId)).handoffs!;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before.id,
      session_id: before.session_id,
      submission_id: before.submission_id,
    });
    expect(
      (
        await f.json<{ requests: unknown[] }>(
          await f.call('/api/device-nodes/requests'),
        )
      ).requests,
    ).toEqual([]);
    expect(f.requests).toHaveLength(1);
    expect(f.submissions).toHaveLength(1);
  } catch (error) {
    throw new Error(String(error) + '\n' + f.diagnostics(), { cause: error });
  } finally {
    await f.dispose();
  }
}, 90000);
