import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Policy = {
  enabled: boolean;
  recallEnabled: boolean;
  captureEnabled: boolean;
  version: number;
};
type Dot = { id: string; name: string; policy: Policy };
type Settings = { credentialConfigured: boolean; dots: Dot[] };

function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : '保存失败，请稍后重试';
}

export function Mem0PrivateSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<Settings>('/api/mem0-private')
      .then((value) => live && setSettings(value))
      .catch((error) => live && setLoadError(errorMessage(error)));
    return () => {
      live = false;
    };
  }, []);

  async function saveKey() {
    if (!apiKey.trim()) return;
    setBusy('key');
    try {
      await api.put('/api/mem0-private/credential', { apiKey });
      setSettings((current) =>
        current ? { ...current, credentialConfigured: true } : current,
      );
      setApiKey('');
      toast.success('Mem0 API Key 已保存');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function removeKey() {
    setBusy('key');
    try {
      await api.delete('/api/mem0-private/credential');
      setSettings((current) =>
        current ? { ...current, credentialConfigured: false } : current,
      );
      setApiKey('');
      toast.success('Mem0 API Key 已移除，后续不会再读写 Mem0');
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function savePolicy(dot: Dot, policy: Policy) {
    setBusy(dot.id);
    try {
      const result = await api.put<{ policy: Policy }>(
        `/api/mem0-private/dots/${encodeURIComponent(dot.id)}`,
        {
          enabled: policy.enabled,
          recallEnabled: policy.recallEnabled,
          captureEnabled: policy.captureEnabled,
        },
      );
      setSettings((current) =>
        current
          ? {
              ...current,
              dots: current.dots.map((item) =>
                item.id === dot.id ? { ...item, policy: result.policy } : item,
              ),
            }
          : current,
      );
      toast.success(`${dot.name} 的 Mem0 设置已保存`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm leading-6 text-muted-foreground">
        Mem0 用于 Dot 私聊的跨会话记忆。Node Durable 和 Coding
        私聊可按设置召回并写入；只有你逐个开启的 Dot
        会读取或发送内容。群聊、消息渠道和云端执行不会使用这里的私人记忆。
      </p>
      <section className="rounded-xl border border-border p-4 sm:p-5">
        <h2 className="font-semibold">Mem0 Platform 连接</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {settings === null
            ? '正在读取连接状态…'
            : settings.credentialConfigured
              ? '已配置 API Key。密钥只保存在宿主机加密存储中，页面不会回显。'
              : '尚未配置 API Key；所有 Dot 均不会向 Mem0 发起请求。'}
        </p>
        <form
          className="mt-4 flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <Input
            aria-label="Mem0 API Key"
            type="password"
            autoComplete="new-password"
            placeholder={
              settings?.credentialConfigured
                ? '输入新密钥以替换'
                : 'Mem0 API Key'
            }
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={busy !== null || !settings}
            className="min-h-11 flex-1"
          />
          <Button
            type="submit"
            disabled={!apiKey.trim() || busy !== null || !settings}
          >
            保存密钥
          </Button>
          {settings?.credentialConfigured && (
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void removeKey()}
            >
              移除密钥
            </Button>
          )}
        </form>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">每个 Dot 单独授权</h2>
        {loadError && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-sm text-destructive"
          >
            <span>读取设置失败：{loadError}</span>
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              重试
            </Button>
          </div>
        )}
        {!settings && !loadError && (
          <p className="text-sm text-muted-foreground">正在读取设置…</p>
        )}
        {settings?.dots.map((dot) => (
          <DotPolicyCard
            key={`${dot.id}:${dot.policy.version}`}
            dot={dot}
            disabled={busy !== null}
            onSave={(policy) => void savePolicy(dot, policy)}
          />
        ))}
      </section>
    </div>
  );
}

function DotPolicyCard({
  dot,
  disabled,
  onSave,
}: {
  dot: Dot;
  disabled: boolean;
  onSave: (policy: Policy) => void;
}) {
  const [policy, setPolicy] = useState(dot.policy);
  const changed =
    policy.enabled !== dot.policy.enabled ||
    policy.recallEnabled !== dot.policy.recallEnabled ||
    policy.captureEnabled !== dot.policy.captureEnabled;
  return (
    <div className="rounded-xl border border-border p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">{dot.name}</h3>
        <Button disabled={!changed || disabled} onClick={() => onSave(policy)}>
          保存
        </Button>
      </div>
      <div className="mt-3 space-y-2 text-sm">
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={policy.enabled}
            disabled={disabled}
            onChange={(event) =>
              setPolicy({ ...policy, enabled: event.target.checked })
            }
          />
          启用这个 Dot 的 Mem0 记忆
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={policy.recallEnabled}
            disabled={disabled}
            onChange={(event) =>
              setPolicy({ ...policy, recallEnabled: event.target.checked })
            }
          />
          在私聊开始前搜索已有记忆
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={policy.captureEnabled}
            disabled={disabled}
            onChange={(event) =>
              setPolicy({ ...policy, captureEnabled: event.target.checked })
            }
          />
          私聊回答完成后，将本轮消息发送给 Mem0 提取记忆
        </label>
      </div>
    </div>
  );
}
