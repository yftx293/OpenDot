import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

const KIMI_CU = '/Applications/KimiCU.app/Contents/MacOS/kimi-cu';

export type KimiCuMcp = {
  call: (method: string, params: unknown) => Promise<any>;
  notify: (method: string) => void;
  close: () => void;
};

/** Stdio JSON-RPC client for an already-running synthetic KimiCU fixture. */
export function openKimiCuMcp(timeoutMs = 10000): KimiCuMcp {
  const child: ChildProcess = spawn(KIMI_CU, ['mcp'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; timer: NodeJS.Timeout }
  >();
  const lines: Interface = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    try {
      const value = JSON.parse(line);
      const waiter = pending.get(value.id);
      if (!waiter) return;
      pending.delete(value.id);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } catch {
      // A non-JSON diagnostic is not an MCP reply.
    }
  });
  return {
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('KimiCU fixture request timed out'));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        child.stdin!.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        );
      });
    },
    notify(method) {
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    close() {
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      pending.clear();
      lines.close();
      child.kill();
    },
  };
}

export async function readKimiCuAppState(input: {
  app: string;
  pid: number;
  windowId: number;
  clientName?: string;
}): Promise<string> {
  const mcp = openKimiCuMcp();
  try {
    const initialized = await mcp.call('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
        name: input.clientName ?? 'opendot-product-fixture',
        version: '1',
      },
    });
    if (initialized.error) throw new Error('Fixture state unavailable');
    mcp.notify('notifications/initialized');
    const value = await mcp.call('tools/call', {
      name: 'get_app_state',
      arguments: {
        app: input.app,
        pid: input.pid,
        window_id: input.windowId,
        mode: 'ax',
        disable_diff: true,
      },
    });
    if (value.error || value.result?.isError)
      throw new Error('Fixture state unavailable');
    return value.result.content
      .filter((part: { type?: string }) => part.type === 'text')
      .map((part: { text: string }) => part.text)
      .join('\n');
  } finally {
    mcp.close();
  }
}
