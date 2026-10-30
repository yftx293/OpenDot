// Platform-neutral provenance algorithm. No package, SDK, Node or storage
// imports: an already-owned host supplies committed readers and its SDK tokens.
export type NativeProductSource<C extends number = number> = {
  conversationId: C;
  toolTaskId: number;
  generationTaskId: number;
  inputs: { submissionId: number; requestId: string; entryId: number }[];
};
export type NativeSourceLive = {
  run?: { taskId: number; inputs: readonly number[] };
  generation?: { attempt: number };
};
export type NativeSourceAccess<C extends number = number> = {
  conversationId: C;
  taskId: number;
  kind: 'tool' | 'generation';
  generationKind: string;
  toolKind: string;
  liveVersion: number;
  task(id: number): Promise<
    | {
        id: number;
        conversationId: number;
        owner?: number;
        kind: string;
        background?: boolean;
        abortRequested?: boolean;
        state: { status: string };
      }
    | undefined
  >;
  submission(id: number): Promise<
    | {
        id: number;
        conversationId: number;
        type: string;
        status: string;
        requestId?: string;
        entry?: number;
      }
    | undefined
  >;
  readLive(): Promise<{ version: number; value: NativeSourceLive } | undefined>;
  authorize(): void | Promise<void>;
  active(): boolean;
};

async function generation(access: NativeSourceAccess) {
  const { conversationId } = access;
  const seen = new Set<number>();
  let id = access.taskId;
  for (let depth = 0; depth < 32; depth++) {
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id))
      throw new Error('Native task ancestry is invalid');
    seen.add(id);
    const task = await access.task(id);
    if (
      !task ||
      task.conversationId !== conversationId ||
      task.background ||
      task.abortRequested ||
      ['terminal', 'completing'].includes(task.state.status)
    )
      throw new Error('Native source task is not active');
    if (
      id === access.taskId &&
      (task.state.status !== 'running' ||
        task.kind !==
          (access.kind === 'tool' ? access.toolKind : access.generationKind))
    )
      throw new Error(
        access.kind === 'tool'
          ? 'Native source requires an actual tool task'
          : 'Native source requires the active generation task',
      );
    if (task.owner === undefined) {
      // While a child Tool Task runs, its generation waits on that child. The
      // root is still the active owner; running-only would reject real tools.
      if (
        task.kind !== access.generationKind ||
        (access.kind === 'generation' && Number(task.id) !== access.taskId)
      )
        throw new Error('Native source has no active generation owner');
      return Number(task.id);
    }
    id = Number(task.owner);
  }
  throw new Error('Native task ancestry exceeds its bound');
}
async function live(access: NativeSourceAccess) {
  const doc = await access.readLive();
  if (!doc || doc.version !== access.liveVersion)
    throw new Error('Native source document version is unavailable');
  return doc.value;
}

/** Inputs must be placed in this exact live generation; admission is not read. */
export function nativeProductSource<C extends number>(
  access: NativeSourceAccess<C> & { kind: 'generation' },
): Promise<NativeProductSource<C> & { attempt: number }>;
export function nativeProductSource<C extends number>(
  access: NativeSourceAccess<C> & { kind: 'tool' },
): Promise<NativeProductSource<C>>;
export function nativeProductSource<C extends number>(
  access: NativeSourceAccess<C>,
): Promise<NativeProductSource<C> & { attempt?: number }>;
export async function nativeProductSource<C extends number>(
  access: NativeSourceAccess<C>,
): Promise<NativeProductSource<C> & { attempt?: number }> {
  if (!access.active()) throw new Error('Durable runtime is not active');
  await access.authorize();
  const owner = await generation(access),
    state = await live(access),
    run = state.run;
  if (
    !run ||
    Number(run.taskId) !== owner ||
    (access.kind === 'generation' && !state.generation?.attempt) ||
    !Array.isArray(run.inputs) ||
    !run.inputs.length ||
    run.inputs.length > 64 ||
    new Set(run.inputs).size !== run.inputs.length
  )
    throw new Error('Native source input generation is unavailable');
  const inputs: NativeProductSource['inputs'] = [];
  for (const id of run.inputs) {
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new Error('Native source submission identity is invalid');
    const row = await access.submission(id);
    if (
      !row ||
      row.type !== 'input' ||
      row.conversationId !== access.conversationId ||
      row.status !== 'placed' ||
      !row.requestId ||
      !Number.isSafeInteger(Number(row.entry)) ||
      Number(row.entry) <= 0
    )
      throw new Error('Native source input is not active in this conversation');
    inputs.push({
      submissionId: Number(row.id),
      requestId: row.requestId,
      entryId: Number(row.entry),
    });
  }
  await access.authorize();
  const after = await live(access);
  if (
    !access.active() ||
    (await generation(access)) !== owner ||
    Number(after.run?.taskId) !== owner ||
    after.generation?.attempt !== state.generation?.attempt ||
    JSON.stringify(after.run?.inputs) !== JSON.stringify(run.inputs)
  )
    throw new Error('Native source generation changed during binding');
  return {
    conversationId: access.conversationId,
    toolTaskId: access.taskId,
    generationTaskId: owner,
    inputs,
    ...(access.kind === 'generation'
      ? { attempt: state.generation!.attempt }
      : {}),
  };
}
