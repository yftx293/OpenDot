import fs from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        workers: [
          {
            name: 'model-fixture',
            modules: true,
            script: fs.readFileSync(
              new URL('./test/model-fixture.js', import.meta.url),
              'utf8',
            ),
            compatibilityDate: '2026-10-13',
          },
          {
            name: 'authority-fixture',
            modules: true,
            script: fs.readFileSync(
              new URL('./test/authority-fixture.js', import.meta.url),
              'utf8',
            ),
            compatibilityDate: '2026-10-13',
            serviceBindings: { MODEL: 'model-fixture' },
          },
        ],
        serviceBindings: {
          MODEL_SERVICE: 'model-fixture',
          MINICLAW_AUTHORITY_SERVICE: 'authority-fixture',
        },
        bindings: {
          MINICLAW_CLOUD_ADMISSION: 'true',
          MINICLAW_CLOUD_SHARED_SECRET:
            'local-workerd-fixture-control-key-32bytes',
          MINICLAW_AUTHORITY_ORIGIN: 'https://authority.fixture',
          MINICLAW_CLOUD_ORIGIN: 'https://gateway.fixture',
          MODEL_BASE_URL: 'https://provider.fixture/v1',
          MODEL_ID: 'fixture-model',
          MODEL_API_KEY: 'fixture-model-key',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
