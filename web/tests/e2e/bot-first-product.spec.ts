import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { expect, test } from '@playwright/test';

for (const base of ['', '/mini']) {
  test(`Bot-first Chief and professional Bot use authorized real main conversations across desktop and iOS-style hash clients${base ? ' under /mini' : ''} (model simulated)`, async ({
    browser,
  }) => {
    test.setTimeout(150000);
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'miniclaw-bot-product-'),
    );
    const desktop = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      isMobile: false,
      hasTouch: false,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0 Safari/537.36',
    });
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    });
    const outsider = await browser.newContext();
    await phone.addInitScript(() =>
      Object.defineProperty(navigator, 'standalone', { value: true }),
    );
    let server: ChildProcess | undefined;
    let serverLog = '';
    let models = 0,
      researchModels = 0;
    const provider = createServer(async (request, response) => {
      if (!request.url?.endsWith('/messages')) {
        response.writeHead(404);
        response.end();
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const research = JSON.stringify(body.system).includes(
        'BOT_RESEARCH_SCOPE',
      );
      models++;
      if (research) researchModels++;
      const answer = research ? 'RESEARCH_ENTRY_REPLY' : 'CHIEF_ENTRY_REPLY';
      const message = {
        id: 'msg_bot_fixture',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 32, output_tokens: 0 },
      };
      if (!body.stream) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ...message,
            content: [{ type: 'text', text: answer }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 32, output_tokens: 10 },
          }),
        );
        return;
      }
      const event = (type: string, value: Record<string, unknown>) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        event('message_start', { message }) +
          event('content_block_start', {
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          event('content_block_delta', {
            index: 0,
            delta: { type: 'text_delta', text: answer },
          }) +
          event('content_block_stop', { index: 0 }) +
          event('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 10 },
          }) +
          event('message_stop', {}),
      );
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const providerPort = (provider.address() as { port: number }).port;
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = (reservation.address() as { port: number }).port;
    let proxy: ReturnType<typeof createServer> | undefined;
    const proxySockets = new Set<net.Socket>();
    let origin = `http://127.0.0.1:${port}`;
    if (base) {
      // Actual loopback reverse proxy strips the deployment prefix for the
      // existing backend, including authenticated HTTP and WebSocket traffic.
      proxy = createServer((incoming, outgoing) => {
        if (incoming.url !== base && !incoming.url?.startsWith(base + '/')) {
          outgoing.writeHead(404);
          outgoing.end();
          return;
        }
        const upstream = httpRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: incoming.url!.slice(base.length) || '/',
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          },
        );
        upstream.on('error', () => {
          if (!outgoing.headersSent) outgoing.writeHead(502);
          outgoing.end();
        });
        incoming.pipe(upstream);
      });
      proxy.on('upgrade', (incoming, socket, head) => {
        if (!incoming.url?.startsWith(base + '/')) {
          socket.destroy();
          return;
        }
        const upstream = net.connect(port, '127.0.0.1', () => {
          const headers = incoming.rawHeaders.reduce(
            (result, value, index, all) =>
              index % 2 === 0
                ? result + value + ': ' + all[index + 1] + '\r\n'
                : result,
            '',
          );
          upstream.write(
            `${incoming.method} ${incoming.url!.slice(base.length)} HTTP/1.1\r\n${headers}\r\n`,
          );
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
      });
      proxy.on('connection', (socket) => {
        proxySockets.add(socket);
        socket.once('close', () => proxySockets.delete(socket));
      });
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}${base}`;
    }
    try {
      fs.mkdirSync(path.join(root, 'home'));
      fs.mkdirSync(path.join(root, 'config'));
      fs.writeFileSync(path.join(root, 'config/default-groups.json'), '[]');
      for (const directory of base ? ['container'] : ['web', 'container'])
        fs.symlinkSync(
          path.join(repository, directory),
          path.join(root, directory),
          'dir',
        );
      if (base) {
        // Give compilation its own bounded allowance; the product journey
        // retains 150 seconds excluding the measured build time.
        const buildStartedAt = Date.now();
        test.setTimeout(150000 + 180000);
        const build = spawn(
          process.execPath,
          [
            path.join(repository, 'web/node_modules/vite/bin/vite.js'),
            'build',
            '--base',
            base + '/',
            '--outDir',
            path.join(root, 'web/dist'),
          ],
          {
            cwd: path.join(repository, 'web'),
            env: { PATH: process.env.PATH },
            stdio: 'ignore',
            timeout: 180000,
          },
        );
        const [code] = await once(build, 'exit');
        test.setTimeout(150000 + Date.now() - buildStartedAt);
        expect(code, 'isolated frontend build with deployment basename').toBe(
          0,
        );
      }
      await new Promise<void>((r) => reservation.close(() => r()));
      server = spawn(
        process.execPath,
        [path.join(repository, 'dist/index.js')],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: path.join(root, 'home'),
            WEB_PORT: String(port),
            CORS_ALLOWED_ORIGINS: new URL(origin).origin,
            ADMIN_HOST_ONLY_MODE: 'true',
            MINICLAW_DURABLE_RUNTIME: 'false',
            PLUGIN_AUTO_SCAN: 'false',
            TZ: 'UTC',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      server.stdout?.on('data', (chunk) => {
        serverLog = (serverLog + chunk.toString()).slice(-20000);
      });
      server.stderr?.on('data', (chunk) => {
        serverLog = (serverLog + chunk.toString()).slice(-20000);
      });
      await expect
        .poll(
          async () => {
            try {
              return (
                await desktop.request.get(`${origin}/api/health`)
              ).status();
            } catch {
              return 0;
            }
          },
          { timeout: 60000 },
        )
        .toBe(200);
      const password = `Bots9!${randomBytes(20).toString('hex')}`;
      expect(
        (
          await desktop.request.post(`${origin}/api/auth/setup`, {
            data: { username: 'bot_owner', password },
          })
        ).status(),
      ).toBe(201);
      expect(
        (
          await desktop.request.post(`${origin}/api/config/claude/providers`, {
            data: {
              name: 'Bot simulated Anthropic provider',
              type: 'third_party',
              anthropicBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
              anthropicApiKey: 'synthetic-bot-model-key',
              anthropicModel: 'fixture-model',
            },
          })
        ).status(),
      ).toBe(201);
      expect(
        (
          await desktop.request.put(`${origin}/api/config/system`, {
            data: { providerSetupSkipped: true },
          })
        ).status(),
      ).toBe(200);
      expect(
        (
          await phone.request.post(`${origin}/api/auth/login`, {
            data: { username: 'bot_owner', password },
          })
        ).status(),
      ).toBe(200);
      const computer = await desktop.newPage();
      await computer.goto(origin);
      await expect(
        computer.getByRole('heading', { name: '今天需要我帮你处理什么？' }),
      ).toBeVisible();
      await expect(computer).toHaveURL(/\/chat\/[^?]+\?bot=/);
      expect(models).toBe(0);
      await computer.goto(`${origin}/bots?view=team`);
      const chiefDetails = computer.getByRole('button', {
        name: 'Miniclaw',
        exact: true,
      });
      await chiefDetails.click();
      const contextPanel = computer.getByRole('complementary', {
        name: 'Miniclaw',
        exact: true,
      });
      await expect(contextPanel).toBeVisible();
      await contextPanel
        .getByRole('tab', { name: '能力', exact: true })
        .click();
      await expect(contextPanel.getByRole('tabpanel')).toContainText(
        'fixture-model',
      );
      await computer.keyboard.press('Home');
      await expect(
        contextPanel.getByRole('tab', { name: '对话', exact: true }),
      ).toBeFocused();
      await contextPanel
        .getByRole('button', { name: '关闭上下文', exact: true })
        .click();
      await expect(chiefDetails).toBeFocused();
      expect(models).toBe(0);
      await computer.goto(`${origin}/bots`);
      await computer
        .getByPlaceholder('输入消息...')
        .fill('Verify the Chief conversation entry.');
      await computer
        .getByRole('button', { name: '发送消息', exact: true })
        .click();
      await expect(computer).toHaveURL(/\/chat\/[^?]+\?bot=/);
      expect(new URL(computer.url()).searchParams.has('agent')).toBe(false);
      await expect(
        computer
          .getByRole('paragraph')
          .filter({ hasText: /^CHIEF_ENTRY_REPLY$/ }),
      ).toBeVisible({ timeout: 45000 });
      expect(models).toBe(1);
      await computer.goto(`${origin}/bots?view=team`);
      await computer
        .getByRole('link', { name: '创建 Bot', exact: true })
        .click();
      await computer
        .getByRole('dialog', { name: '创建新 Dot', exact: true })
        .getByRole('button', { name: '关闭新建 Dot', exact: true })
        .click();
      await computer
        .getByRole('button', { name: '高级配置创建', exact: true })
        .click();
      await computer
        .getByRole('button', { name: '空白创建', exact: true })
        .click();
      await computer.getByLabel('名称', { exact: true }).fill('Researcher');
      for (let step = 0; step < 4; step++)
        await computer
          .getByRole('button', { name: '下一步', exact: true })
          .click();
      const createdProfile = computer.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `${base}/api/agent-profiles`,
        { timeout: 10000 },
      );
      await computer
        .getByRole('button', { name: '创建智能体', exact: true })
        .click();
      const created = await createdProfile;
      expect(created.status()).toBe(201);
      const profileId = (await created.json()).profile.id as string;
      await expect
        .poll(() => new URL(computer.url()).searchParams.get('agent'))
        .toBe(profileId);
      expect(
        (
          await desktop.request.patch(
            `${origin}/api/agent-profiles/${profileId}`,
            {
              data: {
                identity_prompt:
                  'BOT_RESEARCH_SCOPE: research only within the authorized workspace.',
              },
            },
          )
        ).status(),
      ).toBe(200);
      // Exercise the uploaded avatar through the real deployment proxy, not a mock URL.
      expect(
        (
          await desktop.request.post(
            `${origin}/api/agent-profiles/${profileId}/avatar`,
            {
              multipart: {
                avatar: {
                  name: 'profile.png',
                  mimeType: 'image/png',
                  buffer: Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDYQAAAAASUVORK5CYII=',
                    'base64',
                  ),
                },
              },
            },
          )
        ).status(),
      ).toBe(200);
      const before = Object.keys(
        (await (await desktop.request.get(`${origin}/api/groups`)).json())
          .groups,
      );
      await computer.goto(`${origin}/bots?view=team`);
      const researchCard = computer.locator('article').filter({
        has: computer.getByRole('heading', { name: 'Researcher', exact: true }),
      });
      await expect
        .poll(() =>
          researchCard
            .locator('.bot-avatar img')
            .evaluateAll(
              (images: HTMLImageElement[]) => images[0]?.naturalWidth ?? 0,
            ),
        )
        .toBe(1);
      await researchCard
        .getByRole('button', { name: '准备对话', exact: true })
        .click();
      await expect(computer.getByRole('dialog')).toBeVisible();
      await expect(
        computer.getByRole('dialog').getByRole('combobox').first(),
      ).toContainText('Researcher');
      expect(
        Object.keys(
          (await (await desktop.request.get(`${origin}/api/groups`)).json())
            .groups,
        ),
      ).toEqual(before);
      await computer
        .getByLabel('工作区名称', { exact: true })
        .fill('Research conversation');
      await computer
        .getByRole('dialog')
        .getByRole('button', { name: '创建', exact: true })
        .click();
      await expect(computer).toHaveURL(new RegExp(`\\?bot=${profileId}$`));
      const destination = (
        await (
          await desktop.request.get(
            `${origin}/api/agent-profiles/${profileId}/chat-entry`,
          )
        ).json()
      ).destination;
      expect(destination.profile_id).toBe(profileId);
      await computer
        .getByPlaceholder('输入消息...')
        .fill('Use the Researcher profile in its own conversation.');
      await computer
        .getByRole('button', { name: '发送消息', exact: true })
        .click();
      await expect(
        computer
          .getByRole('paragraph')
          .filter({ hasText: /^RESEARCH_ENTRY_REPLY$/ }),
      ).toBeVisible({ timeout: 45000 });
      expect(researchModels).toBeGreaterThan(0);
      await expect(
        computer
          .getByRole('paragraph')
          .filter({ hasText: /^CHIEF_ENTRY_REPLY$/ }),
      ).toHaveCount(0);
      const childResponse = await desktop.request.post(
        `${origin}/api/groups/${encodeURIComponent(destination.workspace_jid)}/sessions`,
        {
          data: { name: 'Remembered child' },
        },
      );
      expect(childResponse.status()).toBe(200);
      const child = await childResponse.json();
      const childId = (child.session ?? child.agent).id as string;
      await computer.reload();
      await computer
        .getByRole('button', { name: '对话列表', exact: true })
        .click();
      await computer
        .getByRole('dialog')
        .locator('button')
        .filter({
          has: computer.getByText('Remembered child', { exact: true }),
        })
        .click();
      await expect(computer).toHaveURL(new RegExp(`agent=${childId}`));
      expect(new URL(computer.url()).searchParams.has('bot')).toBe(false);
      // The legacy workspace link still restores its remembered child, while
      // an explicit Bot entry must open main even with that preference present.
      await computer.goto(
        `${origin}/chat/${encodeURIComponent(destination.folder)}`,
      );
      await expect(computer).toHaveURL(new RegExp(`agent=${childId}`));
      await computer.goto(`${origin}/bots?view=team`);
      await computer
        .locator('article')
        .filter({
          has: computer.getByRole('heading', {
            name: 'Researcher',
            exact: true,
          }),
        })
        .getByRole('button', { name: '开始对话', exact: true })
        .click();
      await expect(computer).toHaveURL(new RegExp(`\\?bot=${profileId}$`));
      await computer.reload();
      await expect(computer).toHaveURL(new RegExp(`\\?bot=${profileId}$`));
      await expect(
        computer
          .getByRole('paragraph')
          .filter({ hasText: /^RESEARCH_ENTRY_REPLY$/ }),
      ).toBeVisible();
      const mobile = await phone.newPage();
      const beforeLaunch = models;
      await mobile.goto(`${origin}/`);
      await expect(mobile).toHaveURL(new RegExp(`#${base}/chat/[^?]+\\?bot=`));
      await expect(
        mobile.getByRole('heading', { name: 'Miniclaw', exact: true }),
      ).toBeVisible();
      expect(models).toBe(beforeLaunch);
      await mobile.goto(`${origin}/#${base}/bots?view=team`);
      await expect
        .poll(() =>
          mobile
            .locator(
              `.bot-contact-row .bot-avatar[data-bot-id="${profileId}"] img`,
            )
            .evaluateAll(
              (images: HTMLImageElement[]) => images[0]?.naturalWidth ?? 0,
            ),
        )
        .toBe(1);
      await mobile
        .locator('article')
        .filter({
          has: mobile.getByRole('heading', { name: 'Researcher', exact: true }),
        })
        .getByRole('button', { name: '开始对话', exact: true })
        .click();
      await expect(mobile).toHaveURL(
        new RegExp(`#${base}/chat/[^?]+\\?bot=${profileId}$`),
      );
      await expect(
        mobile
          .getByRole('paragraph')
          .filter({ hasText: /^RESEARCH_ENTRY_REPLY$/ }),
      ).toBeVisible();
      await mobile.reload();
      await expect(
        mobile
          .getByRole('paragraph')
          .filter({ hasText: /^RESEARCH_ENTRY_REPLY$/ }),
      ).toBeVisible();
      await mobile.goBack();
      await expect(
        mobile.getByRole('heading', { name: '我的 Dot', exact: true }),
      ).toBeVisible();
      await mobile
        .locator('article')
        .filter({
          has: mobile.getByRole('heading', { name: 'Researcher', exact: true }),
        })
        .getByRole('button', { name: '开始对话', exact: true })
        .click();
      await expect(
        mobile
          .getByRole('paragraph')
          .filter({ hasText: /^RESEARCH_ENTRY_REPLY$/ }),
      ).toBeVisible();
      expect(
        (
          await desktop.request.post(`${origin}/api/admin/users`, {
            data: {
              username: 'bot_outsider',
              password,
              role: 'admin',
              must_change_password: false,
            },
          })
        ).status(),
      ).toBe(201);
      expect(
        (
          await outsider.request.post(`${origin}/api/auth/login`, {
            data: { username: 'bot_outsider', password },
          })
        ).status(),
      ).toBe(200);
      expect(
        (
          await outsider.request.get(
            `${origin}/api/agent-profiles/${profileId}/chat-entry`,
          )
        ).status(),
      ).toBe(404);
      expect(
        (
          await outsider.request.post(`${origin}/api/messages`, {
            data: {
              chatJid: destination.workspace_jid,
              content: 'MUST_NOT_ENTER_OTHER_BOT',
              expectedAgentProfileId: profileId,
            },
          })
        ).status(),
      ).toBe(403);
      const profiles = (
        await (await desktop.request.get(`${origin}/api/agent-profiles`)).json()
      ).profiles;
      const chiefId = profiles.find(
        (profile: { is_default: boolean }) => profile.is_default,
      ).id;
      expect(
        (
          await desktop.request.patch(
            `${origin}/api/groups/${encodeURIComponent(destination.workspace_jid)}/agent-profile`,
            { data: { agent_profile_id: chiefId } },
          )
        ).status(),
      ).toBe(200);
      const beforeStale = models;
      const stale = await phone.request.post(`${origin}/api/messages`, {
        data: {
          chatJid: destination.workspace_jid,
          content: 'STALE_BOT_MUST_NOT_RUN',
          expectedAgentProfileId: profileId,
        },
      });
      expect(stale.status()).toBe(409);
      const staleUi = mobile.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `${base}/api/messages`,
        { timeout: 10000 },
      );
      await mobile
        .getByPlaceholder('输入消息...')
        .fill('STALE_BOT_DRAFT_MUST_REMAIN');
      await mobile
        .getByRole('button', { name: '发送消息', exact: true })
        .click();
      expect((await staleUi).status()).toBe(409);
      await expect(mobile.getByText('发送失败', { exact: true })).toBeVisible();
      await expect(mobile.getByPlaceholder('输入消息...')).toHaveValue(
        'STALE_BOT_DRAFT_MUST_REMAIN',
      );
      const cookies = await phone.cookies(origin);
      const socketUrl = new URL(origin);
      socketUrl.protocol = 'ws:';
      socketUrl.pathname = base + '/ws';
      const socket = new WebSocket(socketUrl, {
        handshakeTimeout: 5000,
        headers: {
          Cookie: cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join('; '),
          Origin: new URL(origin).origin,
        },
      });
      try {
        await once(socket, 'open');
        const denied = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Missing stale Bot WebSocket rejection')),
            5000,
          );
          socket.on('message', (bytes) => {
            const message = JSON.parse(bytes.toString());
            if (message.type === 'ws_error') {
              clearTimeout(timer);
              resolve(message.error);
            }
          });
        });
        socket.send(
          JSON.stringify({
            type: 'send_message',
            chatJid: destination.workspace_jid,
            content: 'STALE_WS_BOT_MUST_NOT_RUN',
            expectedAgentProfileId: profileId,
          }),
        );
        expect(await denied).toContain('Bot');
      } finally {
        socket.terminate();
      }
      expect(models).toBe(beforeStale);
      const transcript = await (
        await phone.request.get(
          `${origin}/api/groups/${encodeURIComponent(destination.workspace_jid)}/messages`,
        )
      ).text();
      expect(transcript).not.toContain('STALE_BOT_MUST_NOT_RUN');
      expect(transcript).not.toContain('STALE_WS_BOT_MUST_NOT_RUN');
      expect(transcript).not.toContain('STALE_BOT_DRAFT_MUST_REMAIN');
      expect(
        (
          await (
            await phone.request.get(
              `${origin}/api/agent-profiles/${profileId}/chat-entry`,
            )
          ).json()
        ).destination,
      ).toBeNull();
      const ownerId = (
        await (await desktop.request.get(`${origin}/api/auth/me`)).json()
      ).user.id;
      expect(
        (
          await outsider.request.patch(`${origin}/api/admin/users/${ownerId}`, {
            data: { role: 'member' },
          })
        ).status(),
      ).toBe(200);
      const revoked = await phone.request.post(`${origin}/api/messages`, {
        data: {
          chatJid: destination.workspace_jid,
          content: 'REVOKED_HOST_BOT_MUST_NOT_RUN',
          expectedAgentProfileId: chiefId,
        },
      });
      expect(revoked.status()).toBe(403);
      expect(models).toBe(beforeStale);
      // UI-only empty-list fault. The real backend's code-owned default
      // Profile is deliberately retained; this is not authorization evidence.
      await mobile.route('**/api/agent-profiles', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              json: {
                profiles: [],
                model_configs: [],
                default_model_config_id: null,
              },
            })
          : route.continue(),
      );
      await mobile.goto(`${origin}/#${base}/bots?view=team`);
      await expect(
        mobile.getByText('你的团队还没有 Bot。', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(mobile.locator('article')).toHaveCount(0);
      await mobile.unroute('**/api/agent-profiles');
      expect(
        (await phone.request.post(`${origin}/api/auth/logout`)).status(),
      ).toBe(200);
      expect(
        (
          await phone.request.get(
            `${origin}/api/agent-profiles/${profileId}/chat-entry`,
          )
        ).status(),
      ).toBe(401);
      await mobile.reload();
      await expect(mobile).toHaveURL(new RegExp(`#${base}/login`));
    } catch (error) {
      // This child has only private synthetic fixture credentials and loopback
      // traffic; never inherits the managed environment's provider secrets.
      console.error(serverLog);
      throw error;
    } finally {
      if (server && server.exitCode === null) {
        server.kill('SIGTERM');
        await Promise.race([
          once(server, 'exit'),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
        if (server.exitCode === null) server.kill('SIGKILL');
      }
      await Promise.allSettled([
        desktop.close(),
        phone.close(),
        outsider.close(),
      ]);
      if (reservation.listening)
        await new Promise<void>((r) => reservation.close(() => r()));
      provider.closeAllConnections();
      await new Promise<void>((r) => provider.close(() => r()));
      proxy?.closeAllConnections();
      for (const socket of proxySockets) socket.destroy();
      if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
