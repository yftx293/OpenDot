import type { ReactNode, RefObject } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../ui/sheet';
import { useMediaQuery } from '../../hooks/useMediaQuery';

export type MessageDetails = {
  id: string;
  author: string;
  timestamp: string;
  source: Record<string, unknown>;
  sequence?: number;
};

/** Only display metadata already present in the authorized conversation. */
export function MessageDetailsSheet({
  open,
  onOpenChange,
  message,
  returnFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: MessageDetails;
  returnFocus?: RefObject<HTMLButtonElement | null>;
  children?: ReactNode;
}) {
  const desktop = useMediaQuery('(min-width: 768px)');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={desktop ? 'right' : 'bottom'}
        className="max-h-[85dvh] overflow-y-auto"
        onCloseAutoFocus={
          returnFocus
            ? (event) => {
                event.preventDefault();
                returnFocus.current?.focus();
              }
            : undefined
        }
      >
        <SheetHeader>
          <SheetTitle>消息详情</SheetTitle>
          <SheetDescription>查看这条消息的完整时间与来源。</SheetDescription>
        </SheetHeader>
        <dl className="space-y-4 px-4 py-5 text-sm break-words">
          <div>
            <dt className="text-muted-foreground">发送者</dt>
            <dd>{message.author}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">完整时间</dt>
            <dd>
              <time dateTime={message.timestamp}>
                {new Date(message.timestamp).toLocaleString('zh-CN', {
                  hour12: false,
                  timeZoneName: 'short',
                })}
              </time>
              <span className="block font-mono text-xs">
                {message.timestamp}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">消息标识</dt>
            <dd className="font-mono text-xs">{message.id}</dd>
          </div>
          {message.sequence !== undefined && (
            <div>
              <dt className="text-muted-foreground">群内顺序</dt>
              <dd>{message.sequence}</dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">来源</dt>
            <dd>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {JSON.stringify(message.source, null, 2)}
              </pre>
            </dd>
          </div>
        </dl>
        {children}
      </SheetContent>
    </Sheet>
  );
}
