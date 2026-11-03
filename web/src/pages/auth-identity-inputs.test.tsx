// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const authState = {
    login: vi.fn(),
    register: vi.fn(),
    setupAdmin: vi.fn(),
    checkStatus: vi.fn(),
    initialized: true as boolean | null,
    authenticated: false,
    user: null,
    setupStatus: null,
  };
  return {
    authState,
    get: vi.fn(async () => ({
      allowRegistration: true,
      requireInviteCode: true,
    })),
  };
});

vi.mock('../stores/auth', () => {
  const useAuthStore = Object.assign(
    (selector?: (state: typeof mocks.authState) => unknown) =>
      typeof selector === 'function'
        ? selector(mocks.authState)
        : mocks.authState,
    { getState: () => mocks.authState },
  );
  return { useAuthStore };
});

vi.mock('../api/client', () => ({
  api: {
    get: mocks.get,
  },
}));

const { LoginPage } = await import('./LoginPage');
const { SetupPage } = await import('./SetupPage');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function expectExactText(input: HTMLInputElement) {
  expect(input.getAttribute('autocapitalize')).toBe('none');
  expect(input.getAttribute('autocorrect')).toBe('off');
  expect(input.getAttribute('spellcheck')).toBe('false');
}

async function renderAt(path: string, page: 'login' | 'setup') {
  mocks.authState.initialized = page === 'login' ? true : false;
  mocks.authState.authenticated = false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const router = createMemoryRouter(
    [
      {
        path: '/login',
        element: page === 'login' ? <LoginPage /> : <div>login</div>,
      },
      {
        path: '/setup',
        element: page === 'setup' ? <SetupPage /> : <div>setup</div>,
      },
      { path: '*', element: <div>elsewhere</div> },
    ],
    { initialEntries: [path] },
  );
  await act(async () => {
    root?.render(<RouterProvider router={router} />);
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('auth identity inputs', () => {
  test('login username does not autocapitalize and uses username autocomplete', async () => {
    await renderAt('/login', 'login');

    const username = document.getElementById(
      'login-username',
    ) as HTMLInputElement;
    const password = document.getElementById(
      'login-password',
    ) as HTMLInputElement;

    expect(username).toBeInstanceOf(HTMLInputElement);
    expect(username.type).toBe('text');
    expect(username.name).toBe('username');
    expect(username.getAttribute('autocomplete')).toBe('username');
    expectExactText(username);

    expect(password.type).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
    expectExactText(password);
  });

  test('register username and invite code stay exact', async () => {
    await renderAt('/login', 'login');

    const registerTab = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('去注册'),
    );
    expect(registerTab).toBeDefined();
    await act(async () => {
      registerTab?.click();
    });

    const username = document.getElementById(
      'reg-username',
    ) as HTMLInputElement;
    const invite = document.getElementById('reg-invite') as HTMLInputElement;
    const password = document.getElementById(
      'reg-password',
    ) as HTMLInputElement;

    expect(username.getAttribute('autocomplete')).toBe('username');
    expectExactText(username);
    expect(invite.getAttribute('autocomplete')).toBe('off');
    expectExactText(invite);
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expectExactText(password);
  });

  test('setup create-admin username stays exact even after revealing the password', async () => {
    await renderAt('/setup', 'setup');

    const username = document.getElementById(
      'setup-username',
    ) as HTMLInputElement;
    const password = document.getElementById(
      'setup-password',
    ) as HTMLInputElement;
    const confirm = document.getElementById(
      'setup-password-confirm',
    ) as HTMLInputElement;

    expect(username).toBeInstanceOf(HTMLInputElement);
    expect(username.getAttribute('autocomplete')).toBe('username');
    expectExactText(username);
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expectExactText(password);
    expectExactText(confirm);

    const reveal = password.parentElement?.querySelector('button');
    expect(reveal).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      reveal?.click();
    });

    expect(password.type).toBe('text');
    expect(password.getAttribute('autocapitalize')).toBe('none');
    expect(password.getAttribute('spellcheck')).toBe('false');
  });
});
