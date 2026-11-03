import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Settings = { configured: boolean; enabled: boolean; origin: string; sampleRate: number; active: boolean; restartRequired: boolean; exportCounts?: { exported: number; failed: number; dropped: number } | null };

export function LangfuseSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [publicKey, setPublicKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restart, setRestart] = useState(false);
  const [testResult, setTestResult] = useState('');
  useEffect(() => {
    let live = true;
    api.get<Settings>('/api/observability').then((value) => { if (live) { setSettings(value); setRestart(value.restartRequired); } }).catch(() => { if (live) setError('无法读取配置，请检查管理员权限。'); });
    return () => { live = false; };
  }, []);
  async function save() {
    if (!settings) return;
    if ((!settings.configured && (!publicKey || !secretKey)) || (!!publicKey !== !!secretKey)) {
      setError('请同时填写 Public Key 和 Secret Key。'); return;
    }
    setBusy(true); setError(''); setTestResult('');
    try {
      const result = await api.put<Settings>('/api/observability', {
        enabled: settings.enabled, origin: settings.origin, sampleRate: settings.sampleRate,
        ...(publicKey ? { publicKey, secretKey } : {}),
      });
      setSettings(result); setPublicKey(''); setSecretKey(''); setRestart(true);
      toast.success('配置已保存，重启服务后生效');
    } catch { setError('保存失败，请检查 HTTPS 地址与密钥。'); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm('移除已保存的 Langfuse 配置和密钥？重启服务后停止上报。')) return;
    setBusy(true); setError(''); setTestResult('');
    try {
      const result = await api.delete<Settings>('/api/observability');
      setSettings(result); setPublicKey(''); setSecretKey(''); setRestart(true);
      toast.success('配置已移除，重启服务后停止上报');
    } catch { setError('无法移除配置，请稍后重试。'); }
    finally { setBusy(false); }
  }
  async function testConnection() {
    setBusy(true); setTestResult('');
    try {
      const result = await api.post<{ result: string }>('/api/observability/test', {});
      setTestResult(result.result === 'authenticated' ? '项目认证成功。实际数据上报还需要启用并重启服务。' : result.result === 'unauthorized' ? '认证失败，请检查项目地址和两把密钥。' : '无法验证连接，请检查项目地址和网络。');
    } catch { setTestResult('无法验证连接，请确认已保存配置并检查网络。'); }
    finally { setBusy(false); }
  }
  if (!settings) return <p role={error ? 'alert' : undefined}>{error || '正在读取配置…'}</p>;
  return <div className="max-w-3xl space-y-5">
    <p className="text-sm text-muted-foreground">连接 Langfuse 后可查看运行指标。导出仅包含受限元数据，不发送对话或记忆内容。配置在服务重启后生效。</p>
    <section className="space-y-4 rounded-xl border border-border p-4 sm:p-5">
      <p className="text-sm">导出器：{settings.active ? '已启动' : '未启动'}{settings.configured ? ' · 已保存项目密钥' : ' · 未配置密钥'}</p>
      {settings.active && <p className="text-xs text-muted-foreground">{settings.exportCounts ? `本次启动后：已发送 ${settings.exportCounts.exported} 条，发送失败 ${settings.exportCounts.failed} 条，丢弃 ${settings.exportCounts.dropped} 条。` : ''} 服务接受请求不代表数据已出现在控制台；刷新页面可更新计数。</p>}
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />启用 Langfuse</label>
      <label className="block space-y-1 text-sm">项目地址<Input type="url" value={settings.origin} onChange={(event) => setSettings({ ...settings, origin: event.target.value })} placeholder="https://cloud.langfuse.com" /></label>
      <label className="block space-y-1 text-sm">采样比例（0 到 1）<Input type="number" min="0" max="1" step="0.01" value={settings.sampleRate} onChange={(event) => setSettings({ ...settings, sampleRate: Number(event.target.value) })} /></label>
      <label className="block space-y-1 text-sm">Public Key<Input autoComplete="off" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder={settings.configured ? '留空以保留现有密钥' : '输入 Public Key'} /></label>
      <label className="block space-y-1 text-sm">Secret Key<Input type="password" autoComplete="new-password" value={secretKey} onChange={(event) => setSecretKey(event.target.value)} placeholder={settings.configured ? '留空以保留现有密钥' : '输入 Secret Key'} /></label>
      <p className="text-xs text-muted-foreground">密钥保存在宿主机加密存储中，保存后不会显示。替换时须同时输入两个密钥。</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {restart && <p role="status" className="text-sm">已保存，重启服务后生效。</p>}
      <Button type="button" disabled={busy} onClick={() => void save()}>保存配置</Button>
      {settings.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => void testConnection()}>测试已保存的配置</Button>}
      {settings.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => void remove()}>移除配置和密钥</Button>}
      {testResult && <p role="status" className="text-sm">{testResult}</p>}
    </section>
  </div>;
}
