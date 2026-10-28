import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { it } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);

/**
 * scripts/** is outside every test glob and every tsconfig, so without this
 * shim the preview's read-only gate, RPC allowlist, 0600 report write and
 * V1/V2 valuation would have no regression protection: an edit to
 * gas-backfill's round search or snapshot.mjs's statement gate would leave CI
 * green. The receipt gas preview carries the same shim for the same reason.
 */
it('standalone in-kind preview typechecks and its synthetic safety suite runs in ordinary CI', async () => {
  const env = { ...process.env, DATABASE_URL: '', MERRYMEN_IN_KIND_RPC: '' };
  delete env.NODE_TEST_CONTEXT;
  await run(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--noUncheckedIndexedAccess', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'Bundler', '--allowImportingTsExtensions', '--skipLibCheck', '--types', 'node',
    'scripts/in-kind-preview/value.ts', 'scripts/in-kind-preview/value.test.ts'], { cwd: root, env, timeout: 120_000 });
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--test',
    'scripts/in-kind-preview/preview.test.mjs',
    'scripts/in-kind-preview/value.test.ts'], { cwd: root, env, timeout: 120_000 });
  assert.match(stdout, /(?:#|ℹ) fail 0/);
  assert.doesNotMatch(stdout, /(?:#|ℹ) pass 0\b/);
});
