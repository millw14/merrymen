import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { it } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

it('standalone receipt preview typechecks and its synthetic safety suite runs in ordinary CI', async () => {
  const env = { ...process.env, DATABASE_URL: '', MERRYMEN_RECEIPT_RPC: '', MERRYMEN_RECEIPT_PREVIEW_LOCAL_PG: '' };
  delete env.NODE_TEST_CONTEXT;
  await run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'Bundler', '--allowImportingTsExtensions', '--skipLibCheck',
    'scripts/receipt-gas-preview/runtime.ts', 'scripts/receipt-gas-preview/receipt-proof.ts',
    'scripts/receipt-gas-preview/receipt-proof.test.ts'], { cwd: root, env, timeout: 30_000 });
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--test',
    'scripts/receipt-gas-preview/preview.test.mjs',
    'scripts/receipt-gas-preview/receipt-proof.test.ts',
    'scripts/receipt-gas-preview/runtime.test.mjs',
    'scripts/receipt-gas-preview/preview.postgres.test.mjs'], { cwd: root, env, timeout: 30_000 });
  assert.match(stdout, /(?:#|ℹ) fail 0/);
});
