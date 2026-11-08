// Subprocess fixture: real Harness/SQLite and OS lifecycle, simulated provider/effect service.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  type ConversationId,
  type SubmissionId,
  type TaskId,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { bindDurableInputPayload } from '../../src/personal-agent/durable-input-ledger.js';
import { PiDurableRuntimeAdapter } from '../../src/personal-agent/durable-runtime.js';

const [mode, directory, scenario, position] = process.argv.slice(2);
if (!directory || !['start', 'resume'].includes(mode))
  throw new Error('Invalid worker arguments');
const databasePath = path.join(directory, 'runtime.sqlite');
const manifestPath = path.join(directory, 'manifest.json');

type Manifest = {
  conversationId: number;
  taskId?: number;
  submissionId?: number;
};

async function notify(value: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('Worker requires IPC'));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
}

function save(value: Manifest): void {
  fs.writeFileSync(manifestPath, JSON.stringify(value), { mode: 0o600 });
}

function load(): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
}

async function pauseAtFault(): Promise<never> {
  await notify({ event: 'fault-ready', scenario, position });
  return new Promise<never>(() => undefined);
}

// A simulated external service with a transactional idempotency key and receipt.
function applyEffect(step: number): void {
  const db = new DatabaseSync(path.join(directory, 'effect-service.sqlite'));
  try {
    db.exec(`
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS attempts (step INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS effects (step INTEGER PRIMARY KEY, receipt TEXT NOT NULL);
      BEGIN IMMEDIATE;
    `);
    db.prepare('INSERT INTO attempts(step) VALUES (?)').run(step);
    db.prepare(
      'INSERT OR IGNORE INTO effects(step, receipt) VALUES (?, ?)',
    ).run(step, `receipt-${step}`);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

async function taskScenario(): Promise<void> {
  const Work = defineTask<
    { through: number },
    { phase: 'step'; step: number },
    number
  >({
    name: 'miniclaw.fault-injection.work',
    version: 1,
    initial: () => ({ phase: 'step', step: 1 }),
    phases: {
      step: async (task, runtime, context) => {
        const step = task.state.checkpoint.step;
        if (mode === 'start' && step === 2 && position === 'before-effect')
          await pauseAtFault();
        applyEffect(step);
        if (mode === 'start' && step === 2 && position === 'after-effect')
          await pauseAtFault();
        await runtime.commit(
          () =>
            step >= task.input.through
              ? {
                  status: 'terminal',
                  outcome: { status: 'completed', result: step },
                }
              : {
                  status: 'running',
                  checkpoint: { phase: 'step', step: step + 1 },
                },
          context,
        );
        if (mode === 'start' && step === 2 && position === 'after-checkpoint')
          await pauseAtFault();
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: 'terminal', outcome: { status: 'aborted' } }),
        context,
      );
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: 'miniclaw-fault-test', tasks: [Work] }),
  );
  const harness = await Harness.open(
    await openNodeSqliteStorage(databasePath),
    { models: createModels(), registry },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    let taskId: TaskId<number>;
    if (mode === 'start') {
      taskId = await root.commit(
        (tx) =>
          tx.createTask(
            Work,
            { through: 3 },
            { ownership: { kind: 'conversation' } },
          ),
        BACKGROUND_CONTEXT,
      );
      save({ conversationId: root.id, taskId });
    } else {
      taskId = load().taskId as TaskId<number>;
    }
    const result = await harness.waitForTask(taskId, BACKGROUND_CONTEXT);
    const effects = new DatabaseSync(
      path.join(directory, 'effect-service.sqlite'),
    );
    try {
      await notify({
        event: 'result',
        state: result.state,
        effects: effects
          .prepare('SELECT step, receipt FROM effects ORDER BY step')
          .all(),
        attempts: effects
          .prepare(
            'SELECT step, COUNT(*) AS count FROM attempts GROUP BY step ORDER BY step',
          )
          .all(),
      });
    } finally {
      effects.close();
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

async function modelScenario(): Promise<void> {
  const faux = fauxProvider({
    provider: 'miniclaw-fault-model',
    api: 'miniclaw-fault-api',
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    async () => {
      fs.appendFileSync(
        path.join(directory, 'model-requests.log'),
        'requested\n',
        { mode: 0o600 },
      );
      if (mode === 'start') await pauseAtFault();
      return fauxAssistantMessage('MODEL_RECOVERED');
    },
  ]);
  const harness = await Harness.open(
    await openNodeSqliteStorage(databasePath),
    { models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const model = faux.getModel();
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    let submission;
    if (mode === 'start') {
      submission = await root.submit(
        {
          type: 'input',
          requestId: 'model-interruption',
          content: 'Run the fault-injection probe',
        },
        BACKGROUND_CONTEXT,
      );
      save({ conversationId: root.id, submissionId: submission.id });
    } else {
      // Reacquire the persisted handle. Never resubmit the original prompt.
      submission = await harness.submission(
        load().submissionId as SubmissionId,
        BACKGROUND_CONTEXT,
      );
      if (!submission) throw new Error('Missing persisted submission');
    }
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    const view = await root.context(BACKGROUND_CONTEXT);
    await notify({
      event: 'result',
      submissionId: submission.id,
      persistedSubmissionId: load().submissionId,
      status: settled.status,
      userEntries: view.entries.filter((e) => e.kind === 'pi.user').length,
      assistantEntries: view.entries.filter((e) => e.kind === 'pi.assistant')
        .length,
      modelAttempts: fs
        .readFileSync(path.join(directory, 'model-requests.log'), 'utf8')
        .trim()
        .split('\n').length,
    });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

async function admissionScenario(): Promise<void> {
  if (mode === 'start') {
    const harness = await Harness.open(
      await openNodeSqliteStorage(databasePath),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      await bindDurableInputPayload(
        root,
        'reserved-request',
        'original payload',
      );
      save({ conversationId: root.id });
      await pauseAtFault();
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  } else {
    const adapter = await PiDurableRuntimeAdapter.open({
      databasePath,
      registry: createRegistry(),
      authorizeConversation: () => undefined,
      recordInputRequest: () => undefined,
    });
    try {
      await adapter.activate(() => undefined);
      const conversationId = load().conversationId as ConversationId;
      const first = await adapter.submitInput(
        conversationId,
        'reserved-request',
        'original payload',
      );
      const retry = await adapter.submitInput(
        conversationId,
        'reserved-request',
        'original payload',
      );
      let mismatchRejected = false;
      try {
        await adapter.submitInput(
          conversationId,
          'reserved-request',
          'altered payload',
        );
      } catch (error) {
        mismatchRejected =
          (error as { code?: string }).code === 'DURABLE_INPUT_CONFLICT';
      }
      const view = (await adapter.snapshot(conversationId)) as {
        entries: { kind: string }[];
      };
      await notify({
        event: 'result',
        sameReceipt: first.id === retry.id,
        mismatchRejected,
        userEntries: view.entries.filter((e) => e.kind === 'pi.user').length,
      });
    } finally {
      await adapter.close();
    }
  }
}

const keepAlive = setInterval(() => undefined, 60_000);
void (async () => {
  if (scenario === 'task') await taskScenario();
  else if (scenario === 'model') await modelScenario();
  else if (scenario === 'admission') await admissionScenario();
  else throw new Error('Unknown scenario');
})()
  .catch(async (error: unknown) => {
    await notify({
      event: 'error',
      message: error instanceof Error ? error.message : 'Worker failed',
    });
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(keepAlive);
    process.disconnect();
  });
