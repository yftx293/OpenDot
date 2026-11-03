import { useEffect, useState } from 'react';
import { api, apiFetch } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Paths = { available: boolean; kimiInstalled: boolean; command: string; loader: string | null; desktop: string; computer: string; browser: string };
type Device = { id: string; manifest: { capability: string; servers?: { server_id: string }[] } };
type WindowOption = { appId: string; pid: number; windowId: number; appName: string; title: string };

function outcomeUncertain(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  return error.status === 0 || error.status === 408;
}

export function LocalDeviceSetup({ onCreated, beforeConnect }: { onCreated: () => void; beforeConnect?: () => Promise<void> }) {
  const [paths, setPaths] = useState<Paths | null>(null);
  const [kind, setKind] = useState<'computer' | 'kimicu' | 'webbridge'>('computer');
  const [appId, setAppId] = useState('');
  const [pid, setPid] = useState('');
  const [windowId, setWindowId] = useState('');
  const [session, setSession] = useState('');
  const [tabId, setTabId] = useState('');
  const [origin, setOrigin] = useState('');
  const [port, setPort] = useState('10086');
  const [targetUrl, setTargetUrl] = useState('');
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [windows, setWindows] = useState<WindowOption[]>([]);
  const [loadingWindows, setLoadingWindows] = useState(false);
  useEffect(() => { api.get<Paths>('/api/local-device-setup').then(setPaths).catch(() => setPaths({ available: false } as Paths)); }, []);

  async function listWindows() {
    setLoadingWindows(true); setError('');
    try { setWindows((await apiFetch<{ windows: WindowOption[] }>('/api/local-device-setup/windows', { timeoutMs: 20000 })).windows); }
    catch { setError('无法读取本机窗口列表；也可以手动填写窗口信息。'); }
    finally { setLoadingWindows(false); }
  }

  async function openBrowserTab() {
    setOpening(true); setError('');
    try {
      const result = await apiFetch<{ session: string; tabId: number; origin: string }>('/api/local-device-setup/webbridge-tab', {
        method: 'POST', body: JSON.stringify({ url: targetUrl, port: Number(port) }), timeoutMs: 20000,
      });
      setSession(result.session); setTabId(String(result.tabId)); setOrigin(result.origin);
      setNotice('已请求在 WebBridge 中打开网页；页面读取仅限指定的源地址。');
    } catch { setError('无法打开网页，请确认 WebBridge 已连接并检查网址。'); }
    finally { setOpening(false); }
  }

  async function connect() {
    if (!paths?.available) return;
    setError(''); setNotice('');
    const desktop = kind === 'kimicu';
    const computer = kind === 'computer';
    const positive = (value: string) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
    if (desktop && (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(appId) || !positive(pid) || !positive(windowId))) {
      setError('请填写应用 Bundle ID、进程 ID 和窗口 ID。'); return;
    }
    if (!desktop && !computer) {
      try {
        const url = new URL(origin);
        if (!/^opendot-[0-9a-f-]{36}$/i.test(session) || !positive(tabId) || !positive(port) || Number(port) > 65535 || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('invalid');
      } catch { setError('请填写专用会话、标签 ID、页面源地址和端口。'); return; }
    }
    setBusy(true);
    const id = `opendot_${kind}_${crypto.randomUUID().replaceAll('-', '')}`;
    const tools = desktop ? ['observe_window', 'act_on_window', 'capture_window'] : computer ? ['list_windows', 'open_application', 'observe_window', 'act_on_window'] : ['read_page'];
    const policy = { version: 1, enabled: true, location: { kind: 'device', node_id: crypto.randomUUID() }, tools };
    const env = computer ? {} : desktop
      ? { OPENDOT_KIMICU_APP_ID: appId, OPENDOT_KIMICU_PID: pid, OPENDOT_KIMICU_WINDOW_ID: windowId }
      : { OPENDOT_WEBBRIDGE_SESSION: session, OPENDOT_WEBBRIDGE_TAB_ID: tabId, OPENDOT_WEBBRIDGE_ORIGIN: origin, OPENDOT_WEBBRIDGE_PORT: port };
    try {
      if (beforeConnect) await beforeConnect();
      const args = [...(paths.loader ? ['--import', paths.loader] : []), desktop ? paths.desktop : computer ? paths.computer : paths.browser];
      const declaration = { id, command: paths.command, args, env, pi: policy };
      try { await api.post('/api/mcp-servers', declaration); }
      catch (e) {
        if (!outcomeUncertain(e)) throw e;
        // The first request may have committed even if its reply was lost.
        // Only accept the generated ID if its non-secret declaration matches.
        const existing = await api.get<{ server: { command: string; args: string[]; pi: unknown } }>(`/api/mcp-servers/${id}`);
        if (existing.server.command !== paths.command || JSON.stringify(existing.server.args) !== JSON.stringify(args) || JSON.stringify(existing.server.pi) !== JSON.stringify(policy)) throw new Error('无法确认之前的工具配置，请检查 MCP 设置。');
      }
      const ticketKey = crypto.randomUUID();
      const ticketRequest = () => apiFetch<{ ticket: { pair_code: string } }>('/api/device-nodes/pair-tickets', { method: 'POST', headers: { 'Idempotency-Key': ticketKey }, body: JSON.stringify({ name: computer ? '本机电脑操作' : desktop ? '本机 KimiCU' : '本机 WebBridge' }) });
      let ticketResult;
      try { ticketResult = await ticketRequest(); }
      catch (e) { if (!outcomeUncertain(e)) throw e; ticketResult = await ticketRequest(); }
      const startBody = { serverId: id, pairCode: ticketResult.ticket.pair_code };
      try { await api.post('/api/local-device-setup/start', startBody); }
      catch (e) { if (!outcomeUncertain(e)) throw e; await api.post('/api/local-device-setup/start', startBody); }
      let device: Device | undefined;
      for (let attempt = 0; attempt < 20 && !device; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await api.get<{ devices: Device[] }>('/api/device-nodes');
        device = result.devices.find((entry) => entry.manifest?.capability === 'mcp' && entry.manifest.servers?.some((server) => server.server_id === id));
        if (!device) {
          const status = await api.get<{ state: 'starting' | 'exited' }>(`/api/local-device-setup/status/${id}`);
          if (status.state === 'exited') throw new Error('本机节点未能启动，请检查 Kimi 服务和节点配置。');
        }
      }
      if (!device) throw new Error('节点未在预期时间内连接，请检查本机 Kimi 服务和设备设置。');
      await api.patch(`/api/mcp-servers/${id}`, { pi: { ...policy, location: { kind: 'device', node_id: device.id } } });
      if (computer) {
        const activate = () => api.post('/api/local-device-setup/computer', { serverId: id, nodeId: device.id });
        try { await activate(); } catch (e) { if (!outcomeUncertain(e)) throw e; await activate(); }
        setNotice('电脑操作已启用。现在可以在对话中请求操作电脑；具体操作会请求授权。');
      } else setNotice('节点已连接。请在下方确认设备身份，并在对话中选择工具、授权启动和操作。');
      onCreated();
    } catch (e) {
      setError(e && typeof e === 'object' && 'message' in e ? String(e.message) : '连接失败，请检查设备节点是否已启用。');
      onCreated();
    } finally { setBusy(false); }
  }
  if (!paths) return <p className="text-sm">正在检查本机节点环境…</p>;
  if (!paths.available) return <p className="text-sm text-muted-foreground">本机向导需要 macOS 上可用的 OpenDot 设备节点运行环境；其他设备请使用本地节点配置。</p>;
  return <section className="space-y-3 rounded-xl border border-border p-4">
    <h2 className="font-semibold">连接本机电脑操作</h2>
    <label className="block text-sm">连接方式<select className="mt-1 min-h-11 w-full rounded-lg border bg-background px-3" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="computer">电脑操作（自动选择窗口）</option><option value="kimicu">指定窗口（高级）</option><option value="webbridge">WebBridge 页面读取</option></select></label>
    {kind === 'computer' ? <div className="space-y-2"><p className="text-sm text-muted-foreground">连接后，Dot 可以发现窗口并请求操作授权。请确保 KimiCU 已安装，并在 macOS 中授予其辅助功能权限。</p><Button type="button" variant="outline" onClick={() => { void api.post('/api/local-device-setup/permissions', { permission: 'accessibility' }).catch(() => setError('无法打开系统设置，请手动打开隐私与安全性 → 辅助功能。')); }}>打开 macOS 辅助功能设置</Button></div> : kind === 'kimicu' ? <>
      <Button type="button" variant="outline" disabled={loadingWindows} onClick={() => void listWindows()}>{loadingWindows ? '正在读取窗口…' : '选择本机窗口'}</Button>
      {windows.length > 0 && <label className="block text-sm">可见窗口<select className="mt-1 min-h-11 w-full rounded-lg border bg-background px-3" defaultValue="" onChange={(event) => {
        const chosen = windows.find((entry) => String(entry.windowId) === event.target.value);
        if (chosen) { setAppId(chosen.appId); setPid(String(chosen.pid)); setWindowId(String(chosen.windowId)); }
      }}><option value="">选择窗口</option>{windows.map((entry) => <option key={entry.windowId} value={entry.windowId}>{entry.appName}{entry.title ? ` — ${entry.title}` : ''}</option>)}</select></label>}
      <label className="block text-sm">应用 Bundle ID<Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="例如 com.apple.TextEdit" /></label>
      <label className="block text-sm">进程 ID<Input inputMode="numeric" value={pid} onChange={(e) => setPid(e.target.value)} /></label>
      <label className="block text-sm">窗口 ID<Input inputMode="numeric" value={windowId} onChange={(e) => setWindowId(e.target.value)} /></label>
      <p className="text-xs text-muted-foreground">操作限定在所选窗口，截图需要额外授权。截图的窗口范围尚未完成验证，请仅在可接受截图内容被读取时授权。应用重启后需要重新选择窗口。</p>
    </> : <>
      <label className="block text-sm">要读取的网页<Input type="url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://example.com" /></label>
      <Button type="button" variant="outline" disabled={opening || !targetUrl} onClick={() => void openBrowserTab()}>{opening ? '正在打开…' : '打开网页并选择标签'}</Button>
      <p className="text-xs text-muted-foreground">点击后会在本机浏览器打开该网页；如果网页跳转到其他网站，读取会被拒绝。</p>
      <label className="block text-sm">专用 WebBridge 会话<Input value={session} onChange={(e) => setSession(e.target.value)} placeholder="opendot-…" /></label>
      <label className="block text-sm">标签 ID<Input inputMode="numeric" value={tabId} onChange={(e) => setTabId(e.target.value)} /></label>
      <label className="block text-sm">页面源地址<Input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://example.com" /></label>
      <label className="block text-sm">本机 WebBridge 端口<Input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /></label>
      <p className="text-xs text-muted-foreground">当前只读取指定页面文本，不能导航或点击。</p>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {(kind === 'computer' || kind === 'kimicu') && !paths.kimiInstalled && <p role="alert" className="text-sm text-destructive">未找到 KimiCU，请先在本机安装并打开它。</p>}
    <Button disabled={busy || ((kind === 'computer' || kind === 'kimicu') && !paths.kimiInstalled)} onClick={() => void connect()}>{busy ? '正在连接…' : kind === 'computer' ? '启用电脑操作' : '创建并连接本机节点'}</Button>
  </section>;
}
