import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import {
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet';

/** Keep the exit reachable while a long member/settings form scrolls. */
export function GroupSettingsSheet({
  children,
  side,
}: {
  children: ReactNode;
  side: 'right' | 'bottom';
}) {
  return (
    <SheetContent
      side={side}
      showCloseButton={false}
      className="gap-0 overflow-hidden"
    >
      <SheetHeader className="relative shrink-0 border-b pr-16">
        <SheetTitle>群聊设置</SheetTitle>
        <SheetDescription>
          邀请 Dot、调整回复方式，或管理文件与工具。
        </SheetDescription>
        <SheetClose asChild>
          <Button
            aria-label="关闭群聊设置"
            variant="ghost"
            size="icon"
            className="absolute right-3 top-3 size-11"
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </SheetClose>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
        {children}
      </div>
    </SheetContent>
  );
}
