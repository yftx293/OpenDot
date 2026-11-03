import { useEffect, useRef, useState } from 'react';
import { api, apiFetch, type ApiError } from '../../api/client';
import { pendingInputRequest } from '../../utils/input-receipts';
import { extractErrorMessage } from '../../utils/error';
import { Button } from '../ui/button';

type Device = {
  id: string;
  name: string;
  state: string;
  revision: number;
  online: boolean;
  kimi_readiness: {
    state:
      | 'not_installed'
      | 'unavailable'
      | 'not_running'
      | 'extension_disconnected'
      | 'version_mismatch'
      | 'connected';
    daemonVersion?: string;
    extensionVersion?: string;
    scopedControlAvailable: false;
    computerUse?: {
      state:
        | 'unsupported_platform'
        | 'not_installed'
        | 'unavailable'
        | 'not_registered'
        | 'requires_approval'
        | 'registered'
        | 'legacy_registration';
      permissions: 'unknown';
      doctorPermissions?: {
        accessibility: 'reported_granted' | 'unknown';
        screenRecording: 'reported_granted' | 'unknown';
      };
      scopedControlAvailable: false;
    };
  } | null;
  last_seen_at: string | null;
  manifest:
    | {
        capability: 'files.read';
        root_label: string;
        root_fingerprint: string;
        paths: string[];
      }
    | {
        capability: 'mcp';
        servers: { server_id: string; configuration_digest: string }[];
      };
  grants: {
    id: string;
    workspace_jid: string;
    paths: string[];
    state: string;
    expires_at: string;
    expired: boolean;
  }[];
  mcp_grants: {
    id: string;
    workspace_jid: string;
    session_id: string;
    server_id: string;
    tools: string[];
    allow_images: number;
    state: string;
    expires_at: string;
    expired: boolean;
  }[];
};
const field =
  'min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2';
export function DeviceNodes({
  ownerId,
  workspaces,
  showUnavailable = false,
}: {
  ownerId: string;
  workspaces: { jid: string; name: string }[];
  showUnavailable?: boolean;
}) {
  const [enabled, setEnabled] = useState(false),
    [devices, setDevices] = useState<Device[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(''),
    [ticket, setTicket] = useState<{
      pair_code: string;
      expires_at: string;
    } | null>(null);
  const [workspace, setWorkspace] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [ttl, setTtl] = useState('3600');
  const [reviewing, setReviewing] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [retry, setRetry] = useState(false);
  const alive = useRef(true),
    generation = useRef(0);
  const attempt = useRef<null | {
    path: string;
    body: Record<string, unknown>;
    receipt: { requestId: string; acknowledge: () => void };
  }>(null);
  async function reload() {
    const version = ++generation.current;
    try {
      const [availability, result] = await Promise.all([
        api.get<{ enabled: boolean }>('/api/device-nodes/availability'),
        api.get<{ devices: Device[] }>('/api/device-nodes'),
      ]);
      if (alive.current && version === generation.current) {
        setEnabled(availability.enabled);
        setDevices(result.devices);
      }
    } catch (err) {
      if (alive.current && version === generation.current)
        setError(extractErrorMessage(err));
    }
  }
  useEffect(() => {
    alive.current = true;
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 5000);
    return () => {
      alive.current = false;
      generation.current++;
      clearInterval(timer);
    };
  }, [ownerId]);
  async function submit(path: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!attempt.current)
        attempt.current = {
          path,
          body,
          receipt: await pendingInputRequest(ownerId, {
            kind: 'device',
            path,
            body,
          }),
        };
      if (!alive.current) return;
      const current = attempt.current;
      const result = await apiFetch<{
        ticket?: { pair_code: string; expires_at: string };
      }>(current.path, {
        method: 'POST',
        headers: { 'Idempotency-Key': current.receipt.requestId },
        body: JSON.stringify(current.body),
      });
      current.receipt.acknowledge();
      attempt.current = null;
      if (!alive.current) return;
      if (result.ticket) setTicket(result.ticket);
      setRetry(false);
      setConfirmed(false);
      setReviewing('');
      setSelected([]);
      await reload();
    } catch (err) {
      if (!alive.current) return;
      const status = (err as ApiError).status;
      if (status && status >= 400 && status < 500 && status !== 408) {
        attempt.current?.receipt.acknowledge();
        attempt.current = null;
        setRetry(false);
      } else setRetry(true);
      setError(extractErrorMessage(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (!enabled && !devices.length && !error && !showUnavailable) return null;
  return (
    <section
      aria-label="个人设备"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="font-semibold">个人设备</h2>
      {!enabled && <p role="status" className="text-sm text-muted-foreground">设备节点功能当前未启用，请先在服务端启用设备节点。</p>}
      <p className="text-sm text-muted-foreground">
        本地节点只能使用明确声明并授权的文件或工具。离线时任务等待原设备；不会自动改用云端或其他设备。
        授权读取文件后，文件正文会发送到当前 Gateway 与模型，并保存在执行历史中。
      </p>
      {error && <p role="alert">{error}</p>}
      {retry && (
        <Button
          disabled={busy}
          onClick={() => {
            const current = attempt.current;
            if (current) void submit(current.path, current.body);
          }}
        >
          重试原设备操作
        </Button>
      )}
      <fieldset disabled={busy || retry} className="space-y-3">
        {enabled && (
          <form
            aria-label="配对本地节点"
            onSubmit={(event) => {
              event.preventDefault();
              void submit('/api/device-nodes/pair-tickets', { name });
            }}
            className="flex gap-2"
          >
            <input
              aria-label="设备名称"
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={field}
            />
            <Button type="submit" disabled={!name.trim()}>
              生成配对码
            </Button>
          </form>
        )}
        {ticket && (
          <div role="status" className="space-y-2 break-all text-sm">
            <p>
              配对码（仅通过本地节点的标准输入提供；请勿放入命令参数或聊天）
            </p>
            <code data-testid="device-pair-code">{ticket.pair_code}</code>
            <p>有效期至 {ticket.expires_at}；配对后仍需身份确认与文件授权。</p>
            <Button onClick={() => setTicket(null)}>隐藏配对码</Button>
          </div>
        )}
        {devices.map((device) => (
          <article
            key={device.id}
            className="space-y-2 rounded-lg border p-3"
            aria-label={`设备 ${device.name}`}
          >
            <p>
              {device.name} · {device.state} ·{' '}
              {device.online ? '在线（15 秒心跳窗口）' : '离线'}
            </p>
            <p className="break-all text-xs">
              节点 {device.id} · 最近心跳 {device.last_seen_at ?? '无'}
            </p>
            {device.online && device.kimi_readiness && (
              <p className="text-xs" role="status">
                Kimi 浏览器连接：
                {
                  (
                    {
                      not_installed: '未安装',
                      unavailable: '状态不可用',
                      not_running: '未运行',
                      extension_disconnected: '扩展未连接',
                      version_mismatch: '版本不匹配',
                      connected: '已连接',
                    } as const
                  )[device.kimi_readiness.state]
                }
                。浏览器控制尚未启用。
              </p>
            )}
            {device.online && device.kimi_readiness?.computerUse && (
              <p className="text-xs" role="status">
                Kimi 桌面服务：
                {
                  (
                    {
                      unsupported_platform: '当前系统不支持',
                      not_installed: '未安装',
                      unavailable: '状态不可用',
                      not_registered: '未注册',
                      requires_approval: '等待系统批准',
                      registered: '已注册',
                      legacy_registration: '旧版注册',
                    } as const
                  )[device.kimi_readiness.computerUse.state]
                }
                。
                {device.kimi_readiness.computerUse.doctorPermissions && (
                  <>
                    诊断进程报告：辅助功能
                    {device.kimi_readiness.computerUse.doctorPermissions
                      .accessibility === 'reported_granted'
                      ? '可用'
                      : '未确认'}
                    ，屏幕录制
                    {device.kimi_readiness.computerUse.doctorPermissions
                      .screenRecording === 'reported_granted'
                      ? '可用'
                      : '未确认'}
                    ；服务进程权限仍需实际验证。
                  </>
                )}
                桌面控制需要单独授权。
              </p>
            )}
            {device.manifest.capability === 'files.read' ? (
              <>
                <p className="break-all text-xs">
                  声明目录 {device.manifest.root_label} · 指纹{' '}
                  {device.manifest.root_fingerprint}
                </p>
                <ul className="break-all text-sm">
                  {device.manifest.paths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                <p className="text-xs">
                  声明不等于授权。节点本地不提供写入、Shell、应用或浏览器能力。
                </p>
              </>
            ) : (
              <>
                <p className="text-xs">已声明的 MCP 服务；声明不等于授权。</p>
                <ul className="break-all text-sm">
                  {device.manifest.servers.map((server) => (
                    <li key={server.server_id}>
                      {server.server_id} · {server.configuration_digest}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {device.mcp_grants.map((grant) => (
              <div key={grant.id} className="text-sm">
                <p>
                  {grant.workspace_jid} · {grant.server_id} ·{' '}
                  {grant.tools.join(', ')} · {grant.state}
                  {grant.allow_images === 1 ? ' · 允许截图' : ''}
                  {grant.expired ? '（已到期）' : ''} · {grant.expires_at}
                </p>
                {grant.state === 'active' && !grant.expired && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      撤销后不会再发起新的设备操作；已发出的操作可能已经生效，请在设备上核对。
                    </p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void submit(
                          `/api/device-nodes/mcp-grants/${grant.id}/revoke`,
                          { confirmed: true },
                        )
                      }
                    >
                      撤销 MCP 授权
                    </Button>
                  </>
                )}
              </div>
            ))}
            {device.grants.map((grant) => (
              <div key={grant.id} className="text-sm">
                <p>
                  {grant.workspace_jid} · {grant.state}
                  {grant.expired ? '（已到期）' : ''} · {grant.paths.join(', ')}{' '}
                  · {grant.expires_at}
                </p>
                {grant.state === 'active' && (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void submit(
                        `/api/device-nodes/grants/${grant.id}/revoke`,
                        { confirmed: true },
                      )
                    }
                  >
                    撤销文件授权
                  </Button>
                )}
              </div>
            ))}
            {reviewing !== device.id && device.state !== 'revoked' && (
              <Button
                variant="outline"
                onClick={() => {
                  setReviewing(device.id);
                  setConfirmed(false);
                  setSelected([]);
                }}
              >
                审查设备与授权
              </Button>
            )}
            {reviewing === device.id && (
              <div className="space-y-2">
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  我已核对本地节点 ID 和能力声明
                </label>
                {enabled && device.state === 'pending' && (
                  <Button
                    disabled={!confirmed}
                    onClick={() =>
                      void submit(`/api/device-nodes/${device.id}/approve`, {
                        expected_revision: device.revision,
                        confirmed: true,
                      })
                    }
                  >
                    确认节点身份（不授予文件访问）
                  </Button>
                )}
                {enabled &&
                  device.state === 'active' &&
                  device.manifest.capability === 'files.read' && (
                    <form
                      aria-label={`授权设备 ${device.name}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submit(`/api/device-nodes/${device.id}/grants`, {
                          confirmed: true,
                          expected_revision: device.revision,
                          workspace_jid: workspace,
                          capability: 'files.read',
                          paths: selected,
                          ttl_seconds: Number(ttl),
                        });
                      }}
                      className="space-y-2"
                    >
                      <select
                        aria-label="设备授权工作区"
                        required
                        className={field}
                        value={workspace}
                        onChange={(event) => setWorkspace(event.target.value)}
                      >
                        <option value="">选择工作区</option>
                        {workspaces.map((item) => (
                          <option key={item.jid} value={item.jid}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      {device.manifest.paths.map((path) => (
                        <label
                          key={path}
                          className="flex min-h-11 items-center gap-2 break-all"
                        >
                          <input
                            type="checkbox"
                            checked={selected.includes(path)}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked
                                  ? [...selected, path]
                                  : selected.filter((item) => item !== path),
                              )
                            }
                          />
                          允许读取 {path}
                        </label>
                      ))}
                      <label>
                        授权有效秒数（60–86400）
                        <input
                          aria-label="设备授权有效秒数"
                          className={field}
                          type="number"
                          min={60}
                          max={86400}
                          required
                          value={ttl}
                          onChange={(event) => setTtl(event.target.value)}
                        />
                      </label>
                      <Button
                        type="submit"
                        disabled={!confirmed || !workspace || !selected.length}
                      >
                        授权所选文件
                      </Button>
                    </form>
                  )}
                <Button
                  variant="destructive"
                  disabled={!confirmed}
                  onClick={() =>
                    void submit(`/api/device-nodes/${device.id}/revoke`, {
                      expected_revision: device.revision,
                      confirmed: true,
                    })
                  }
                >
                  撤销此设备
                </Button>
              </div>
            )}
          </article>
        ))}
      </fieldset>
    </section>
  );
}
