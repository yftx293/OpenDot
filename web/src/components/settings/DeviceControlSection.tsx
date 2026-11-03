import { useEffect, useState } from 'react';
import { DeviceNodes } from '@/components/goals/DeviceNodes';
import { useAuthStore } from '@/stores/auth';
import { useGroupsStore } from '@/stores/groups';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { LocalDeviceSetup } from './LocalDeviceSetup';

type DeviceSettings = { enabled: boolean; source: 'environment' | 'settings' | 'invalid'; mcpEnabled: boolean };

export function DeviceControlSection() {
  const userId = useAuthStore((state) => state.user?.id);
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const groups = useGroupsStore((state) => state.groups);
  const loadGroups = useGroupsStore((state) => state.loadGroups);
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [computerConfigured, setComputerConfigured] = useState(false);
  const [computerOnline, setComputerOnline] = useState(false);
  useEffect(() => { void loadGroups(); }, [loadGroups]);
  useEffect(() => {
    let live = true;
    if (isAdmin) api.get<DeviceSettings>('/api/device-nodes/settings')
      .then((value) => { if (live) setSettings(value); })
      .catch(() => { if (live) setError('无法读取设备设置。'); });
    return () => { live = false; };
  }, [isAdmin]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      if (isAdmin && settings?.enabled) void api.get<{ configured: boolean; online: boolean }>('/api/local-device-setup/computer')
        .then((value) => { if (live) { setComputerConfigured(value.configured); setComputerOnline(value.online); } })
        .catch(() => { if (live) setComputerOnline(false); });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [isAdmin, settings?.enabled, revision]);
  async function setEnabled(enabled: boolean) {
    setBusy(true); setError('');
    try {
      if (!enabled && computerConfigured) await api.delete('/api/local-device-setup/computer');
      setSettings(await api.put<DeviceSettings>('/api/device-nodes/settings', { enabled }));
      setRevision((value) => value + 1);
    } catch { setError('无法保存设备设置，请检查服务端配置。'); }
    finally { setBusy(false); }
  }
  const workspaces = Object.entries(groups)
    .filter(([jid, group]) => jid.startsWith('web:') && group.execution_mode === 'host')
    .map(([jid, group]) => ({ jid, name: group.name }));
  return <div className="max-w-3xl space-y-5">
    <p className="text-sm text-muted-foreground">连接本机设备后，可在会话中为选定工具授权。设备离线或未授权时不会执行操作。</p>
    <div className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
      电脑操作使用本机 KimiCU 发现窗口并执行经授权的操作；WebBridge 当前仅支持读取指定页面。
    </div>
    {isAdmin && settings && <section className="rounded-xl border border-border p-4 space-y-3">
      <p className="text-sm">设备节点：{settings.enabled ? '已启用' : '未启用'}{settings.source === 'environment' ? '（由服务环境控制）' : ''}</p>
      <p className="text-sm text-muted-foreground">开启后允许用户配对设备，并启用 MCP 会话配置；工具启动及操作仍须单独授权。关闭后禁止新的配对与授权；已有授权可在设备列表中撤销。</p>
      {settings.enabled && !settings.mcpEnabled && <p role="alert" className="text-sm text-destructive">MCP 功能被服务环境关闭，设备工具暂不可用。</p>}
      <Button variant="outline" disabled={busy || settings.source === 'environment'} onClick={() => void setEnabled(!settings.enabled)}>{settings.enabled ? '关闭设备节点' : '启用设备节点'}</Button>
    </section>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {isAdmin && settings && (settings.enabled ? settings.mcpEnabled : settings.source !== 'environment') && (computerConfigured ? <section className="rounded-xl border border-border p-4 space-y-3">
      <p className="text-sm">电脑操作已启用 · {computerOnline ? '本机在线' : '本机离线或正在连接'}</p>
      <p className="text-sm text-muted-foreground">你可以在对话中让 Dot 打开应用并操作；具体调用需要授权。</p>
      <Button variant="outline" disabled={busy} onClick={() => { setBusy(true); void api.delete('/api/local-device-setup/computer').then(() => setRevision((value) => value + 1)).catch(() => setError('关闭电脑操作失败，请稍后重试。')).finally(() => setBusy(false)); }}>关闭电脑操作</Button>
    </section> : <LocalDeviceSetup beforeConnect={async () => {
      if (settings.enabled) return;
      const updated = await api.put<DeviceSettings>('/api/device-nodes/settings', { enabled: true });
      setSettings(updated);
      if (!updated.enabled || !updated.mcpEnabled) throw new Error('设备或 MCP 功能被服务环境禁用。');
    }} onCreated={() => setRevision((value) => value + 1)} />)}
    {userId && <DeviceNodes key={revision} ownerId={userId} workspaces={workspaces} showUnavailable />}
  </div>;
}
