import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiFetch } from '../../api/client';
import { useAuthStore } from '../../stores/auth';
import { pendingInputRequest } from '../../utils/input-receipts';

export type McpApprovalView = {
  id: string;
  parameters_digest: string;
  state: string;
  expires_at: number;
  intent: {
    server_id: string;
    original_name: string;
    arguments_digest: string;
  };
};
type ServerOption = {
  server_id: string;
  configuration_digest: string;
  tools: string[];
  transport: string;
  target?: string;
  location: { kind: 'host' } | { kind: 'device'; node_id: string };
};
type Consent = {
  id: string;
  state: string;
  expires_at: number;
  binding_json: string;
};
type Options = {
  supported: boolean;
  reason?: string;
  servers: ServerOption[];
  consents: Consent[];
  dot_id?: string;
  approvals?: McpApprovalView[];
};
type DeviceOption = {
  id: string;
  name: string;
  state: string;
  revision: number;
  online: boolean;
  manifest:
    | { capability: 'files.read' }
    | {
        capability: 'mcp';
        servers: { server_id: string; configuration_digest: string }[];
      };
};
const button = 'min-h-11 rounded-lg border px-3 text-sm disabled:opacity-50';

/** Owner controls over the existing product service. No tools/URLs or native
 * identities are invented in the browser; unknown outcomes keep their receipt. */
export function SessionMcpTools({
  jid,
  sessionId,
  rows,
  refresh,
  canConsent = true,
  isGroup = false,
  coding = false,
}: {
  jid: string;
  sessionId: string;
  rows: McpApprovalView[];
  refresh(): Promise<void>;
  canConsent?: boolean;
  isGroup?: boolean;
  coding?: boolean;
}) {
  const owner = useAuthStore((s) => s.user?.id);
  const base = `/api/groups/${encodeURIComponent(jid)}/sessions/${encodeURIComponent(sessionId)}`;
  const key = `${owner ?? ''}:${base}`,
    current = useRef(key);
  current.current = key;
  const [options, setOptions] = useState<Options | null>(null);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const grantAttempt = useRef<{ key: string; id: string } | null>(null);
  const [serverId, setServer] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [ttl, setTtl] = useState(900);
  const [confirmed, setConfirmed] = useState(false);
  const [allowImages, setAllowImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [argumentsByCall, setArguments] = useState<Record<string, unknown>>({});
  const requestBusy = useRef(false);
  useEffect(() => {
    current.current = key;
    setOptions(null);
    setDevices([]);
    grantAttempt.current = null;
    setServer('');
    setSelected([]);
    setConfirmed(false);
    setAllowImages(false);
    setArguments({});
    setNotice('');
    setBusy(false);
    requestBusy.current = false;
    return () => {
      current.current = '';
    };
  }, [key]);
  const valid = (ticket: string) =>
    current.current === ticket &&
    !!owner &&
    useAuthStore.getState().user?.id === owner;
  const run = async (work: (ticket: string) => Promise<void>) => {
    if (!owner || requestBusy.current) return;
    const ticket = key;
    requestBusy.current = true;
    setBusy(true);
    setNotice('');
    try {
      await work(ticket);
    } catch {
      if (valid(ticket))
        setNotice('未确认操作结果，原申请编号已保留。请刷新核对后重试。');
    } finally {
      if (valid(ticket)) {
        requestBusy.current = false;
        setBusy(false);
      }
    }
  };
  const load = async (ticket: string) => {
    const [value, nodes] = await Promise.all([
      api.get<Options>(base + '/mcp'),
      api.get<{ devices: DeviceOption[] }>('/api/device-nodes'),
    ]);
    if (valid(ticket)) {
      setOptions(value);
      setDevices(nodes.devices);
    }
  };
  useEffect(() => {
    if (!coding || !owner) return;
    let stopped = false;
    const poll = async () => {
      try {
        const value = await api.get<Options>(base + '/mcp');
        if (!stopped && valid(key)) setOptions(value);
      } catch {
        /* The next poll will retry without interrupting chat. */
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [coding, owner, base, key]);
  const server = options?.servers.find((s) => s.server_id === serverId);
  const deviceNodeId =
    server?.location?.kind === 'device' ? server.location.node_id : undefined;
  const device = deviceNodeId
    ? devices.find(
        (d) =>
          d.id === deviceNodeId &&
          d.state === 'active' &&
          d.manifest.capability === 'mcp',
      )
    : undefined;
  const declared =
    device?.manifest.capability === 'mcp'
      ? device.manifest.servers.find((s) => s.server_id === server?.server_id)
      : undefined;
  const argumentKey = (row: McpApprovalView) =>
    row.id + ':' + row.parameters_digest;
  const decide = (row: McpApprovalView, decision: 'approve' | 'deny') =>
    run(async (ticket) => {
      const payload = {
        kind: 'mcp-approval',
        base,
        approvalId: row.id,
        parametersDigest: row.parameters_digest,
        decision,
      };
      const receipt = await pendingInputRequest(owner!, payload);
      if (!valid(ticket)) return;
      await api.post(`${base}/mcp/approvals/${encodeURIComponent(row.id)}`, {
        parametersDigest: row.parameters_digest,
        decision,
        requestId: receipt.requestId,
      });
      receipt.acknowledge();
      if (valid(ticket)) await refresh();
    });
  return (
    <section aria-label="外部工具授权" className="min-w-0 space-y-3">
      {[
        ...new Map(
          [...rows, ...(options?.approvals ?? [])].map((row) => [row.id, row]),
        ).values(),
      ]
        .filter((row) =>
          ['pending', 'uncertain', 'dispatching'].includes(row.state),
        )
        .map((row) => (
          <article
            key={row.id}
            className="min-w-0 space-y-2 rounded-lg border p-3"
          >
            <h3 className="break-words font-medium">
              {row.intent.server_id} · {row.intent.original_name}
            </h3>
            {row.state === 'pending' ? (
              <>
                <p className="text-xs text-muted-foreground">
                  仅批准此次调用和下方具体参数。有效期至{' '}
                  {new Date(row.expires_at).toLocaleString()}。
                </p>
                {row.expires_at <= Date.now() && (
                  <p role="status" className="text-sm">
                    请求已过期，请刷新状态。
                  </p>
                )}
                {Object.hasOwn(argumentsByCall, argumentKey(row)) ? (
                  <pre
                    aria-label="此次工具参数"
                    className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm"
                  >
                    {JSON.stringify(argumentsByCall[argumentKey(row)], null, 2)}
                  </pre>
                ) : (
                  <button
                    type="button"
                    className={button}
                    disabled={busy || row.expires_at <= Date.now()}
                    onClick={() =>
                      void run(async (ticket) => {
                        const value = await api.get<{ arguments: unknown }>(
                          `${base}/mcp/approvals/${encodeURIComponent(row.id)}/arguments`,
                        );
                        if (valid(ticket))
                          setArguments((before) => ({
                            ...before,
                            [argumentKey(row)]: value.arguments,
                          }));
                      })
                    }
                  >
                    查看此次参数
                  </button>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={button}
                    disabled={
                      busy ||
                      !canConsent ||
                      row.expires_at <= Date.now() ||
                      !Object.hasOwn(argumentsByCall, argumentKey(row))
                    }
                    onClick={() => void decide(row, 'approve')}
                  >
                    批准此次调用
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy || row.expires_at <= Date.now()}
                    onClick={() => void decide(row, 'deny')}
                  >
                    拒绝
                  </button>
                </div>
              </>
            ) : (
              <p role="status" className="text-sm">
                {row.state === 'dispatching'
                  ? '请求已派发，正在核对结果。'
                  : '工具可能已执行，请先核对实际效果；不会自动重发。'}
              </p>
            )}
          </article>
        ))}
      {!canConsent && (
        <p role="status" className="text-sm text-muted-foreground">
          这个 Dot 当前没有有效的群聊执行租约。下一轮开始后可授权外部工具。
        </p>
      )}
      {canConsent && (
        <details
          className="max-h-[60dvh] overflow-y-auto"
          onToggle={(event) => {
            if (event.currentTarget.open && !options) void run(load);
          }}
        >
          <summary className="min-h-11 cursor-pointer py-3 text-sm">
            本会话的外部工具
          </summary>
          <div className="min-w-0 space-y-3 pb-3">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run(load)}
            >
              刷新授权状态
            </button>
            {options && !options.supported && (
              <p className="text-sm text-muted-foreground">
                {options.reason === 'cloud-unsupported'
                  ? 'Cloud 会话尚不支持外部 MCP。'
                  : '服务端尚未启用外部 MCP。'}
              </p>
            )}
            {options?.supported && !options.servers.length && (
              <p className="text-sm">
                当前 Dot 没有可用的外部工具配置。先在{' '}
                <Link className="text-primary underline" to="/capabilities/mcp">
                  MCP 服务设置
                </Link>{' '}
                中配置服务和 Pi 工具范围，并在 Dot 能力中启用它。
              </p>
            )}
            {!!options?.servers.length && (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (
                    !server ||
                    !confirmed ||
                    !selected.length ||
                    selected.length > 50
                  )
                    return;
                  void run(async (ticket) => {
                    let deviceGrantId: string | undefined;
                    if (server.location?.kind === 'device') {
                      if (
                        !device ||
                        !device.online ||
                        !declared ||
                        !options?.dot_id
                      )
                        throw new Error('Device unavailable');
                      const grantBody = {
                        confirmed: true,
                        expected_revision: device.revision,
                        workspace_jid: jid,
                        session_id: sessionId,
                        dot_id: options.dot_id,
                        server_id: server.server_id,
                        declaration_digest: declared.configuration_digest,
                        tools: [...selected].sort(),
                        allow_images: allowImages,
                        ttl_seconds: ttl,
                      };
                      const grantKey = JSON.stringify({
                        device: device.id,
                        ...grantBody,
                      });
                      if (grantAttempt.current?.key === grantKey)
                        deviceGrantId = grantAttempt.current.id;
                      else {
                        const grantReceipt = await pendingInputRequest(owner!, {
                          kind: 'mcp-device-grant',
                          device: device.id,
                          ...grantBody,
                        });
                        const result = await apiFetch<{
                          grant: { grant_id: string };
                        }>(
                          `/api/device-nodes/${encodeURIComponent(device.id)}/mcp-grants`,
                          {
                            method: 'POST',
                            headers: {
                              'Idempotency-Key': grantReceipt.requestId,
                            },
                            body: JSON.stringify(grantBody),
                          },
                        );
                        grantReceipt.acknowledge();
                        deviceGrantId = result.grant.grant_id;
                        grantAttempt.current = {
                          key: grantKey,
                          id: deviceGrantId,
                        };
                      }
                    }
                    const payload = {
                      server_id: server.server_id,
                      configuration_digest: server.configuration_digest,
                      tools: [...selected].sort(),
                      ttl_seconds: ttl,
                      confirmed_startup_and_restart: true,
                      ...(deviceGrantId
                        ? { device_grant_id: deviceGrantId }
                        : {}),
                    };
                    const receipt = await pendingInputRequest(owner!, {
                      kind: 'mcp-startup',
                      base,
                      ...payload,
                    });
                    if (!valid(ticket)) return;
                    const result = await api.post<{ consent: Consent }>(
                      base + '/mcp/consents',
                      { ...payload, request_id: receipt.requestId },
                      45000,
                    );
                    receipt.acknowledge();
                    grantAttempt.current = null;
                    if (valid(ticket)) {
                      setConfirmed(false);
                      await load(ticket);
                      await refresh();
                      setNotice(
                        result.consent.state === 'active'
                          ? '已授权所选工具，每次调用仍需确认具体参数。'
                          : '未确认服务启动；重新授权前请核对它是否已启动。',
                      );
                    }
                  });
                }}
              >
                <label className="block space-y-1 text-sm">
                  服务
                  <select
                    aria-label="外部工具服务"
                    className="min-h-11 w-full rounded-lg border bg-background px-3"
                    value={serverId}
                    disabled={busy}
                    onChange={(e) => {
                      setServer(e.target.value);
                      setSelected([]);
                      setConfirmed(false);
                      setAllowImages(false);
                    }}
                  >
                    <option value="">选择已配置的服务</option>
                    {options.servers.map((s) => (
                      <option key={s.server_id} value={s.server_id}>
                        {s.server_id}
                      </option>
                    ))}
                  </select>
                </label>
                {server && (
                  <>
                    <p className="break-all text-xs text-muted-foreground">
                      {server.location?.kind === 'device'
                        ? '设备程序'
                        : server.transport === 'stdio'
                          ? '服务端程序'
                          : '服务地址'}
                      ：{server.target}
                    </p>
                    {server.location?.kind === 'device' && (
                      <p className="text-sm">
                        {device && declared
                          ? `设备 ${device.name} · ${device.online ? '在线' : '离线'}`
                          : '配对设备或服务声明不可用'}
                      </p>
                    )}
                    <fieldset className="max-h-48 overflow-y-auto">
                      <legend className="text-sm">允许哪些工具</legend>
                      {server.tools.map((name) => (
                        <label
                          key={name}
                          className="flex min-h-11 items-center gap-2 break-all text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selected.includes(name)}
                            disabled={busy}
                            onChange={(e) =>
                              setSelected((before) =>
                                e.target.checked
                                  ? [...before, name]
                                  : before.filter((n) => n !== name),
                              )
                            }
                          />
                          {name}
                        </label>
                      ))}
                      {selected.length > 50 && (
                        <p role="status" className="text-sm">
                          单次最多选择 50 个工具。
                        </p>
                      )}
                    </fieldset>
                    <label className="block space-y-1 text-sm">
                      有效期
                      <select
                        aria-label="外部工具授权有效期"
                        className="min-h-11 w-full rounded-lg border bg-background px-3"
                        value={ttl}
                        disabled={busy}
                        onChange={(e) => setTtl(Number(e.target.value))}
                      >
                        <option value={900}>15 分钟</option>
                        <option value={3600}>1 小时</option>
                        <option value={86400}>24 小时</option>
                      </select>
                    </label>
                    {server.location?.kind === 'device' && (
                      <label className="flex min-h-11 items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={allowImages}
                          disabled={busy}
                          onChange={(event) =>
                            setAllowImages(event.target.checked)
                          }
                        />
                        允许此授权的工具返回截图；截图可能包含登录后的页面信息。
                      </label>
                    )}
                    <label className="flex min-h-11 items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={confirmed}
                        disabled={busy}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      {server.location?.kind === 'device'
                        ? '允许已配对设备启动此服务；重新启动需再次授权。每次调用仍需确认参数。'
                        : '允许服务端启动此服务，并在本会话有效期内重启。每次调用仍需确认参数。'}
                      {isGroup && '授权仅限当前群聊执行租约。'}
                    </label>
                    <button
                      className={button}
                      disabled={
                        busy ||
                        !confirmed ||
                        !selected.length ||
                        selected.length > 50 ||
                        (server.location?.kind === 'device' &&
                          (!device?.online || !declared))
                      }
                      type="submit"
                    >
                      授权所选工具
                    </button>
                  </>
                )}
              </form>
            )}
            {options?.consents.map((consent) => {
              let name = '外部服务';
              try {
                name = JSON.parse(consent.binding_json).server_id;
              } catch {
                /* Unknown metadata never grants access. */
              }
              return (
                <div
                  key={consent.id}
                  className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
                >
                  <span className="break-all">
                    {name} ·{' '}
                    {(
                      {
                        active: '已批准（运行前复核）',
                        starting: '启动待核对',
                        revoked: '已撤销',
                        uncertain: '启动结果待核对',
                      } as Record<string, string>
                    )[consent.state] ?? '状态待核对'}
                  </span>
                  {['active', 'starting'].includes(consent.state) && (
                    <button
                      type="button"
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void run(async (ticket) => {
                          await api.delete(
                            `${base}/mcp/consents/${encodeURIComponent(consent.id)}`,
                          );
                          if (valid(ticket)) {
                            await load(ticket);
                            await refresh();
                          }
                        })
                      }
                    >
                      撤销授权
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
      {notice && (
        <p role="status" className="break-words text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
