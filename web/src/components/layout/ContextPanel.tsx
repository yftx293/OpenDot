import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { Button } from '../ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../ui/sheet';

type Content = {
  key: string;
  title: string;
  description: string;
  body: ReactNode;
};
type ContextState = {
  content: Content | null;
  open: (value: Content) => void;
  close: () => void;
  update: (key: string, body: ReactNode) => void;
  restoreFocus: () => void;
};
const Context = createContext<ContextState | null>(null);

/** Presentation only. Callers retain their live server snapshots and controls. */
export function ProductContextProvider({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey?: string;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback(() => {
    requestAnimationFrame(() => {
      if (origin.current?.isConnected)
        origin.current.focus({ preventScroll: true });
    });
  }, []);
  const open = useCallback((value: Content) => {
    origin.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setContent(value);
  }, []);
  const close = useCallback(() => {
    setContent(null);
    restoreFocus();
  }, [restoreFocus]);
  const update = useCallback((key: string, body: ReactNode) => {
    setContent((current) =>
      current?.key === key ? { ...current, body } : current,
    );
  }, []);
  useEffect(() => setContent(null), [resetKey]);
  return (
    <Context.Provider value={{ content, open, close, update, restoreFocus }}>
      {children}
    </Context.Provider>
  );
}
export function useProductContext() {
  const state = useContext(Context);
  if (!state) throw new Error('Product context must be inside the app shell');
  return state;
}
export function ContextPanelOutlet() {
  const { content, close, restoreFocus } = useProductContext();
  const desktop = useMediaQuery('(min-width: 1101px)');
  if (!content) return null;
  if (desktop)
    return (
      <aside
        className="product-context"
        aria-label={content.title}
        key={content.key}
      >
        <div className="product-context-heading">
          <h2 className="text-sm font-medium">{content.title}</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭上下文"
            onClick={close}
          >
            <X />
          </Button>
        </div>
        <p className="mb-5 text-sm text-muted-foreground">
          {content.description}
        </p>
        {content.body}
      </aside>
    );
  return (
    <Sheet
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <SheetContent
        side="bottom"
        className="px-5"
        key={content.key}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <SheetHeader className="px-0 pr-10">
          <SheetTitle>{content.title}</SheetTitle>
          <SheetDescription>{content.description}</SheetDescription>
        </SheetHeader>
        {content.body}
      </SheetContent>
    </Sheet>
  );
}
