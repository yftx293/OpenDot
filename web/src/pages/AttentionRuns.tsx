import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';

type AttentionItem = {
  id: string;
  title: string;
  summary: string;
  href: string;
  kind: 'approval' | 'blocked';
};

export function AttentionRuns() {
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => {
      void api
        .get<{ items: AttentionItem[] }>('/api/tasks/attention')
        .then((value) => {
          if (live) {
            setItems(value.items);
            setError('');
          }
        })
        .catch(() => {
          if (live) setError('暂时无法读取需要处理的工作。');
        });
    };
    load();
    const timer = window.setInterval(load, 8000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <PageHeader
          title="需要你处理"
          subtitle="停住的工作和等你确认的操作"
          className="mb-5"
          actions={
            <Link to="/tasks" className="text-sm text-muted-foreground">
              定时任务
            </Link>
          }
        />
        {error && (
          <p role="alert" className="mb-4 text-sm">
            {error}
          </p>
        )}
        {items && items.length === 0 && (
          <EmptyState
            title="没有需要你处理的工作"
            description="进行中的对话会留在会话里。"
          />
        )}
        <ul className="space-y-2">
          {(items ?? []).map((item) => (
            <li key={item.id}>
              <Link
                to={item.href}
                className="block rounded-lg border border-border px-4 py-3 hover:bg-muted/60"
              >
                <span className="block text-sm font-medium">{item.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  {item.summary}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
