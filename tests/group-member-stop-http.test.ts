// Actual product entry and native Pi Sessions; inference is synthetic.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import {
  botHandoffHttpFixture,
  waitFor,
} from './helpers/bot-handoff-http-fixture.js';
import {
  freshMemberGroup,
  memberEnvelopes,
} from './helpers/member-inbox-http-fixture.js';
const flags = {
  MINICLAW_GROUP_MEMBER_INBOX: 'true',
  MINICLAW_GROUP_MEMBER_CONCURRENCY: 'true',
};

test('stopping one active member fences only its lease and preserves the other native execution', async () => {
  const f = await botHandoffHttpFixture(undefined, flags);
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f);
    f.setModel(() => ({ hold: true }));
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Both named members should independently inspect the preview.',
        mentions: people.map((p) => p.id),
        dispatch: true,
      }),
    );
    await waitFor(() => f.held.size === 2, 60000);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const before = await f.snapshot(groupId),
      run = before.discussion!.run!;
    const lease = db
      .prepare(
        'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(run.id, people[1].id) as any;
    const original = db
      .prepare(
        'SELECT id,payload,payload_digest FROM bot_group_member_inputs ORDER BY id',
      )
      .all();
    const url = `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[1].id}/stop`;
    expect((await f.call(url, 'POST', { lease_id: randomUUID() })).status).toBe(
      409,
    );
    expect(
      (
        await f.call(
          `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[0].id}/stop`,
          'POST',
          { lease_id: lease.id },
        )
      ).status,
    ).toBe(409);
    expect(f.held.size).toBe(2);
    await f.json(await f.call(url, 'POST', { lease_id: lease.id }));
    await waitFor(
      () =>
        (
          db!
            .prepare('SELECT state FROM bot_group_member_leases WHERE id=?')
            .get(lease.id) as any
        ).state === 'done',
      60000,
    );
    const stopped = await f.snapshot(groupId);
    expect(stopped.discussion!.run!.status).toBe('running');
    expect(stopped.discussion!.run!.cancel_epoch).toBe(run.cancel_epoch);
    expect(stopped.discussion!.run!.stop_state).toBeNull();
    expect(
      stopped.discussion!.member_tasks?.find(
        (m) => m.profile_id === people[1].id,
      ),
    ).toMatchObject({ state: 'stopped', can_stop: false });
    expect(
      stopped.discussion!.member_tasks?.find(
        (m) => m.profile_id === people[0].id,
      ),
    ).toMatchObject({ state: 'active', can_stop: true });
    expect(f.held.size).toBe(1);
    expect(
      f.releaseMatching(
        (body) =>
          memberEnvelopes(body).at(-1)?.recipient_profile_id === people[1].id,
        { text: 'LATE_STOPPED_MEMBER_MUST_NOT_PUBLISH' },
      ),
    ).toBe(0);
    expect(
      db
        .prepare(
          'SELECT id,payload,payload_digest FROM bot_group_member_inputs ORDER BY id',
        )
        .all(),
    ).toEqual(original);
    await f.json(await f.call(url, 'POST', { lease_id: lease.id }));
    expect(
      db.prepare('SELECT count(*) n FROM bot_group_member_stops').get(),
    ).toEqual({ n: 1 });
    const write = new Database(path.join(f.root, 'data/db/messages.db'));
    try {
      expect(() =>
        write
          .prepare(
            'UPDATE bot_group_member_stops SET created_at=created_at WHERE lease_id=?',
          )
          .run(lease.id),
      ).toThrow('Member Stop provenance is immutable');
      expect(() =>
        write
          .prepare('DELETE FROM bot_group_member_stops WHERE lease_id=?')
          .run(lease.id),
      ).toThrow('Member Stop provenance cannot be discarded');
    } finally {
      write.close();
    }
    f.release({
      text: 'UNRELATED_MEMBER_FINISHED',
      usage: { input: 31, output: 7 },
    });
    await waitFor(
      async () =>
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed',
      60000,
    );
    const done = await f.snapshot(groupId);
    expect(
      done.messages.filter((m) => m.content === 'UNRELATED_MEMBER_FINISHED'),
    ).toHaveLength(1);
    expect(
      done.messages.some(
        (m) => m.content === 'LATE_STOPPED_MEMBER_MUST_NOT_PUBLISH',
      ),
    ).toBe(false);
    expect(f.requests).toHaveLength(2);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM bot_group_member_model_admissions WHERE state IN ('active','waiting')",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);

test('a stopped reviewer sends a causal cancellation notice only to its dependent, without inventing a peer answer or waking the idle observer', async () => {
  const f = await botHandoffHttpFixture(undefined, flags);
  let db: Database.Database | undefined;
  try {
    const { groupId, people } = await freshMemberGroup(f, true, [
      'Developer',
      'Reviewer',
      'Observer',
    ]);
    let asks = 0,
      failure: unknown;
    f.setModel((body) => {
      try {
        const envelopes = memberEnvelopes(body),
          current = envelopes.at(-1)!;
        expect(current.recipient_profile_id).not.toBe(people[2].id);
        if (current.recipient_profile_id === people[1].id)
          return { hold: true };
        const control = envelopes.find((e) => e.input_kind === 'control');
        if (control) {
          expect(control.member_stop.profile_id).toBe(people[1].id);
          expect(control.member_stop.cancelled_mail_ids).toHaveLength(1);
          expect(envelopes.some((e) => e.input_kind === 'reply')).toBe(false);
          return {
            text: 'CONTINUED_WITHOUT_A_REVIEWER_REPLY',
            usage: { input: 31, output: 7 },
          };
        }
        if (++asks === 1)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: 'Review this independent preview before I finalize.',
              },
            },
            usage: { input: 31, output: 7 },
          };
        return { hold: true };
      } catch (error) {
        failure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Developer, ask the reviewer while continuing your preview.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f.held.size === 2, 60000);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const reviewer = db
      .prepare(
        'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(run.id, people[1].id) as any;
    const frozen = db
      .prepare(
        'SELECT id,payload,payload_digest FROM bot_group_member_inputs ORDER BY id',
      )
      .all();
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[1].id}/stop`,
        'POST',
        { lease_id: reviewer.id },
      ),
    );
    await waitFor(
      () =>
        (
          db!
            .prepare(
              "SELECT count(*) n FROM bot_group_member_inputs WHERE kind='control' AND state='submitted'",
            )
            .get() as any
        ).n === 1,
      60000,
    );
    expect(f.held.size).toBe(1);
    f.release({
      text: 'PROVISIONAL_MUST_NOT_PUBLISH',
      usage: { input: 31, output: 7 },
    });
    await waitFor(async () => {
      if (failure) throw failure;
      return (
        (await f.snapshot(groupId)).discussion?.run?.status === 'completed'
      );
    }, 60000);
    const done = await f.snapshot(groupId);
    expect(
      done.messages.filter(
        (m) => m.content === 'CONTINUED_WITHOUT_A_REVIEWER_REPLY',
      ),
    ).toHaveLength(1);
    expect(
      done.messages.some((m) => m.content === 'PROVISIONAL_MUST_NOT_PUBLISH'),
    ).toBe(false);
    expect(
      db.prepare('SELECT kind,state FROM bot_group_member_mail').all(),
    ).toEqual([{ kind: 'question', state: 'cancelled' }]);
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM bot_group_member_inputs WHERE profile_id=?',
        )
        .get(people[2].id),
    ).toEqual({ n: 0 });
    for (const row of frozen as any[])
      expect(
        db
          .prepare(
            'SELECT id,payload,payload_digest FROM bot_group_member_inputs WHERE id=?',
          )
          .get(row.id),
      ).toEqual(row);
    expect(f.requests).toHaveLength(4);
    const control = db
      .prepare(
        "SELECT request_id FROM bot_group_member_inputs WHERE kind='control'",
      )
      .get() as any;
    expect(
      (
        db
          .prepare(
            'SELECT source_inputs FROM bot_group_member_model_requests WHERE run_id=? AND session_id IN (SELECT session_id FROM bot_group_member_leases WHERE profile_id=?) ORDER BY created_at DESC LIMIT 1',
          )
          .get(run.id, people[0].id) as any
      ).source_inputs,
    ).toContain(control.request_id);
  } catch (error) {
    console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f.dispose();
  }
}, 180000);

test('a cancelled-dependency control admission rolls back if its approval revocation cannot be persisted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-stop-atomic-'));
  const fault = path.join(root, 'fail-session.json'),
    observed = path.join(root, 'observed'),
    preload = path.join(root, 'fault.mjs');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
import Database from ${JSON.stringify(pathToFileURL(path.resolve('node_modules/better-sqlite3/lib/index.js')).href)};
const original=Database.prototype.prepare;
Database.prototype.prepare=function(sql,...args){
 const statement=Reflect.apply(original,this,[sql,...args]);
 if(!sql.includes('UPDATE product_approvals SET state=CASE')||!sql.includes('WHERE session_id=? AND state IN'))return statement;
 return new Proxy(statement,{get(target,key){
  if(key==='run')return (...values)=>{
   if(fs.existsSync(${JSON.stringify(fault)})&&JSON.parse(fs.readFileSync(${JSON.stringify(fault)},'utf8')).session_id===values[0]){
    fs.writeFileSync(${JSON.stringify(observed)},'revocation write failed');
    throw new Error('INJECTED_MEMBER_STOP_REVOCATION_WRITE_FAILED');
   }
   return Reflect.apply(target.run,target,values);
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
};`,
  );
  let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined,
    db: Database.Database | undefined;
  try {
    f = await botHandoffHttpFixture(preload, flags);
    const { groupId, people } = await freshMemberGroup(f);
    let asks = 0;
    f.setModel((body) => {
      const current = memberEnvelopes(body).at(-1)!;
      if (current.recipient_profile_id === people[0].id && ++asks === 1)
        return {
          tool: {
            name: 'ask_group_dot',
            arguments: {
              recipient_profile_id: people[1].id,
              message: 'Inspect the preview independently.',
            },
          },
          usage: { input: 31, output: 7 },
        };
      return { hold: true };
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content:
          'Developer should ask the reviewer before continuing the preview.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f!.held.size === 2, 60000);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const leases = db
      .prepare('SELECT * FROM bot_group_member_leases WHERE run_id=?')
      .all(run.id) as any[];
    const target = leases.find((l) => l.profile_id === people[1].id)!,
      dependent = leases.find((l) => l.profile_id === people[0].id)!;
    const originalBotMessages = (await f.snapshot(groupId)).messages
      .filter((m) => m.author_kind === 'bot')
      .map((m) => m.id);
    fs.writeFileSync(
      fault,
      JSON.stringify({ session_id: dependent.session_id }),
    );
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[1].id}/stop`,
        'POST',
        { lease_id: target.id },
      ),
    );
    await waitFor(() => fs.existsSync(observed), 60000);
    await waitFor(
      async () =>
        (await f!.snapshot(groupId)).discussion?.run?.status === 'failed',
      60000,
    );
    await waitFor(() => f!.held.size === 0, 60000);
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM bot_group_member_inputs WHERE run_id=? AND kind='control'",
        )
        .get(run.id),
    ).toEqual({ n: 0 });
    // The separate target Stop intent remains committed and its native model was aborted.
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM bot_group_member_stops WHERE lease_id=?',
        )
        .get(target.id),
    ).toEqual({ n: 1 });
    expect(
      (await f.snapshot(groupId)).messages
        .filter((m) => m.author_kind === 'bot')
        .map((m) => m.id),
    ).toEqual(originalBotMessages);
    expect(f.requests).toHaveLength(3);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } catch (error) {
    if (f) console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);

test('a cancelled question deadline cannot expire the surviving recipient control continuation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'member-stop-deadline-'));
  const clock = path.join(root, 'clock.txt'),
    preload = path.join(root, 'clock.mjs');
  fs.writeFileSync(clock, '0');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';const now=Date.now.bind(Date);Date.now=()=>now()+Number(fs.readFileSync(${JSON.stringify(clock)},'utf8'));`,
  );
  let f: Awaited<ReturnType<typeof botHandoffHttpFixture>> | undefined,
    db: Database.Database | undefined;
  try {
    f = await botHandoffHttpFixture(preload, flags);
    const { groupId, people } = await freshMemberGroup(f);
    let asks = 0,
      failure: unknown;
    f.setModel((body) => {
      try {
        const es = memberEnvelopes(body),
          current = es.at(-1)!;
        if (es.some((e) => e.input_kind === 'control')) {
          expect(current.recipient_profile_id).toBe(people[1].id);
          return {
            text: 'RECIPIENT_FINISHED_AFTER_CANCELLED_QUESTION_DEADLINE',
            usage: { input: 31, output: 7 },
          };
        }
        if (current.recipient_profile_id === people[0].id && ++asks === 1)
          return {
            tool: {
              name: 'ask_group_dot',
              arguments: {
                recipient_profile_id: people[1].id,
                message: 'Inspect this preview independently.',
              },
            },
            usage: { input: 31, output: 7 },
          };
        return { hold: true };
      } catch (error) {
        failure = error;
        return { text: 'SYNTHETIC_ASSERTION_FAILED' };
      }
    });
    await f.json(
      await f.call(`/api/bot-groups/${groupId}/messages`, 'POST', {
        content: 'Developer asks the reviewer while working.',
        mentions: [people[0].id],
        dispatch: true,
      }),
    );
    await waitFor(() => f!.held.size === 2, 60000);
    db = new Database(path.join(f.root, 'data/db/messages.db'), {
      readonly: true,
    });
    const run = (await f.snapshot(groupId)).discussion!.run!;
    const target = db
      .prepare(
        'SELECT * FROM bot_group_member_leases WHERE run_id=? AND profile_id=?',
      )
      .get(run.id, people[0].id) as any;
    const question = db
      .prepare(
        "SELECT id,deadline_at FROM bot_group_member_mail WHERE run_id=? AND kind='question'",
      )
      .get(run.id) as any;
    await f.json(
      await f.call(
        `/api/bot-groups/${groupId}/discussions/${run.id}/members/${people[0].id}/stop`,
        'POST',
        { lease_id: target.id },
      ),
    );
    await waitFor(
      () =>
        f!.held.size === 1 &&
        (
          db!
            .prepare(
              "SELECT count(*) n FROM bot_group_member_inputs WHERE kind='control' AND state='submitted'",
            )
            .get() as any
        ).n === 1,
      60000,
    );
    fs.writeFileSync(clock, '120001');
    f.release({
      text: 'CANCELLED_QUESTION_ANSWER_MUST_NOT_PUBLISH',
      usage: { input: 31, output: 7 },
    });
    await waitFor(
      async () =>
        (await f!.snapshot(groupId)).discussion?.run?.status !== 'running',
      60000,
    );
    const done = await f.snapshot(groupId);
    expect(done.discussion!.run).toMatchObject({
      status: 'completed',
      error_code: null,
    });
    if (failure) throw failure;
    expect(
      done.messages.filter(
        (m) =>
          m.content === 'RECIPIENT_FINISHED_AFTER_CANCELLED_QUESTION_DEADLINE',
      ),
    ).toHaveLength(1);
    expect(
      done.messages.some(
        (m) => m.content === 'CANCELLED_QUESTION_ANSWER_MUST_NOT_PUBLISH',
      ),
    ).toBe(false);
    expect(
      db
        .prepare(
          'SELECT id,deadline_at,state FROM bot_group_member_mail WHERE id=?',
        )
        .get(question.id),
    ).toEqual({ ...question, state: 'cancelled' });
    expect(f.requests).toHaveLength(4);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } catch (error) {
    if (f) console.error(f.diagnostics());
    throw error;
  } finally {
    db?.close();
    await f?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
