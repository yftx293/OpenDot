import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('product terminology', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  test('uses Dot-first navigation while preserving existing intelligent-agent configuration terms', () => {
    const productSurface = [
      'web/src/components/layout/nav-items.ts',
      'web/src/components/layout/UnifiedSidebar.tsx',
      'web/src/pages/ChatPage.tsx',
      'web/src/pages/AgentProfilesPage.tsx',
      'web/src/components/chat/CreateContainerDialog.tsx',
      'web/src/pages/UsagePage.tsx',
      'web/src/pages/SettingsPage.tsx',
    ]
      .map(read)
      .join('\n');

    expect(productSurface).toContain("label: '我的 Dot'");
    expect(productSurface).toContain("label: 'Dot 配置'");
    expect(productSurface).toContain('主智能体');
    expect(productSurface).toContain('自定义智能体');
    expect(productSurface).toContain('为智能体新建工作区');
    expect(productSurface).toContain('智能体运行次数');
    expect(productSurface).not.toMatch(
      /label: 'Agent'|主 Agent|自定义 Agent|Agent 工作区|选择 Agent|创建 Agent|Agent 运行次数|Agent 列表/,
    );
  });

  test('rollback restores the chat entry without removing existing configuration or Goal links', async () => {
    vi.stubEnv('VITE_BOT_FIRST_HOME', 'false');
    vi.resetModules();
    const { filterNavItems } =
      await import('../web/src/components/layout/nav-items.js');
    const paths = filterNavItems(false, true).map((item) => item.path);
    expect(paths[0]).toBe('/chat');
    expect(paths).not.toContain('/bots');
    expect(paths).toContain('/agent-profiles');
    expect(paths).toContain('/goals');
  });

  test('keeps Pi runtime and subagent terminology technically explicit', () => {
    const login = read('web/src/pages/LoginPage.tsx');
    const streaming = read('web/src/components/chat/StreamingDisplay.tsx');
    const workflow = read('web/src/components/chat/WorkflowRunCard.tsx');
    const tools = read('web/src/components/chat/ToolActivityCard.tsx');
    const readme = read('README.md');

    expect(login).toContain('Powered by Pi Agent Runtime');
    expect(streaming).toContain('子 Agent:');
    expect(workflow).toContain('个 Agent');
    expect(tools).toContain("case 'Agent':");
    expect(readme).toContain('Pi Agent Runtime');
    expect(readme).toContain('一个对话栏');
  });
});
