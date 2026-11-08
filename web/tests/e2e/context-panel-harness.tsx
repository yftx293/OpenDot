// Presentation fixture only; product state is verified in redesign-shell.spec.ts.
import { createRoot } from 'react-dom/client';
import {
  ProductContextProvider,
  ContextPanelOutlet,
  useProductContext,
} from '../../src/components/layout/ContextPanel';
import { Button } from '../../src/components/ui/button';
import '../../src/styles/globals.css';
import '../../src/styles/product.css';
function Fixture() {
  const context = useProductContext();
  return (
    <>
      <main className="flex-1 p-6">
        <Button
          onClick={() =>
            context.open({
              key: 'presentation',
              title: '当前工作',
              description: '仅验证呈现与焦点，不代表真实任务。',
              body: (
                <>
                  <p>等待设备</p>
                  <Button onClick={context.close}>返回聊天</Button>
                </>
              ),
            })
          }
        >
          查看当前工作
        </Button>
        <Button variant="ghost">背景操作</Button>
      </main>
      <ContextPanelOutlet />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <ProductContextProvider>
    <div className="product-shell">
      <Fixture />
    </div>
  </ProductContextProvider>,
);
