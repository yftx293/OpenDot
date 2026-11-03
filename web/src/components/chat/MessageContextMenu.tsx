import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  FileText,
  ImageDown,
  Trash2,
  Info,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { api } from '../../api/client';
import { showToast } from '../../utils/toast';

interface MessageContextMenuProps {
  content: string;
  position: { x: number; y: number };
  onClose: () => void;
  chatJid?: string;
  messageId?: string;
  onShareImage?: () => void;
  onDetails?: () => void;
  allowFeedback?: boolean;
}

export function MessageContextMenu({
  content,
  position,
  onClose,
  chatJid,
  messageId,
  onShareImage,
  onDetails,
  allowFeedback,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savingFeedback, setSavingFeedback] = useState(false);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${position.y - rect.height - 8}px`;
    }
    menu.querySelector<HTMLButtonElement>('button')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [position, onClose]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    onClose();
  };

  const handleCopyText = () => {
    const plain = content
      .replace(/```[\s\S]*?```/g, (m) =>
        m.replace(/```\w*\n?/, '').replace(/\n?```$/, ''),
      )
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    copyToClipboard(plain);
  };

  const handleCopyMarkdown = () => copyToClipboard(content);

  const feedbackPath = (() => {
    if (!allowFeedback || !chatJid || !messageId) return null;
    const marker = chatJid.lastIndexOf('#agent:');
    if (marker < 1) return null;
    const workspace = chatJid.slice(0, marker),
      session = chatJid.slice(marker + 7);
    if (!session) return null;
    return `/api/groups/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}/messages/${encodeURIComponent(messageId)}/feedback`;
  })();
  const sendFeedback = async (score: -1 | 1) => {
    if (!feedbackPath || savingFeedback) return;
    setSavingFeedback(true);
    try {
      const current = await api.get<{ feedback: { version: number } | null }>(
        feedbackPath,
      );
      await api.put(feedbackPath, {
        score,
        expectedVersion: current.feedback?.version ?? 0,
        requestId: crypto.randomUUID(),
      });
      showToast('反馈已保存');
      onClose();
    } catch {
      showToast('反馈未保存', '请稍后重试。');
      setSavingFeedback(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (chatJid && messageId) {
      await useChatStore.getState().deleteMessage(chatJid, messageId);
    }
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60]" onClick={onClose}>
      <div
        ref={menuRef}
        className="absolute bg-surface rounded-xl shadow-lg border border-border py-1 min-w-[160px] animate-in zoom-in-95 fade-in duration-150 select-none"
        style={{ left: position.x, top: position.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {feedbackPath && (
          <>
            <button
              disabled={savingFeedback}
              onClick={() => void sendFeedback(1)}
              className="flex min-h-11 w-full items-center gap-3 px-4 text-sm hover:bg-muted disabled:opacity-50"
            >
              <ThumbsUp className="h-4 w-4" />
              有帮助
            </button>
            <button
              disabled={savingFeedback}
              onClick={() => void sendFeedback(-1)}
              className="flex min-h-11 w-full items-center gap-3 px-4 text-sm hover:bg-muted disabled:opacity-50"
            >
              <ThumbsDown className="h-4 w-4" />
              没帮助
            </button>
            <div className="mx-3 my-0.5 border-t border-border" />
          </>
        )}
        {onDetails && (
          <button
            onClick={() => {
              onClose();
              onDetails();
            }}
            className="flex min-h-11 w-full items-center gap-3 px-4 text-sm hover:bg-muted"
          >
            <Info className="h-4 w-4" />
            消息详情
          </button>
        )}
        <button
          onClick={handleCopyText}
          className="group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm text-foreground rounded-lg hover:bg-foreground/10 active:bg-foreground/15 transition-colors"
        >
          <Copy className="w-4 h-4 text-muted-foreground group-hover/item:text-primary transition-colors" />
          复制文本
        </button>
        <div className="mx-3 my-0.5 border-t border-border" />
        <button
          onClick={handleCopyMarkdown}
          className="group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm text-foreground rounded-lg hover:bg-foreground/10 active:bg-foreground/15 transition-colors"
        >
          <FileText className="w-4 h-4 text-muted-foreground group-hover/item:text-primary transition-colors" />
          复制 Markdown
        </button>
        {onShareImage && (
          <>
            <div className="mx-3 my-0.5 border-t border-border" />
            <button
              onClick={() => {
                onShareImage();
                onClose();
              }}
              className="group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm text-foreground rounded-lg hover:bg-foreground/10 active:bg-foreground/15 transition-colors"
            >
              <ImageDown className="w-4 h-4 text-muted-foreground group-hover/item:text-primary transition-colors" />
              生成分享图片
            </button>
          </>
        )}
        {chatJid && messageId && (
          <>
            <div className="mx-3 my-0.5 border-t border-border" />
            <button
              onClick={handleDelete}
              className={`group/item w-full flex items-center gap-3 mx-1 px-3 py-2.5 text-sm rounded-lg transition-colors ${
                confirmDelete
                  ? 'text-red-400 bg-red-500/20 hover:bg-red-500/30'
                  : 'text-red-400 hover:bg-foreground/10 hover:text-red-500 active:bg-foreground/15'
              }`}
            >
              <Trash2
                className={`w-4 h-4 transition-colors ${confirmDelete ? '' : 'group-hover/item:text-red-500'}`}
              />
              {confirmDelete ? '确认删除' : '删除消息'}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
