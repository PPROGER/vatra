// node-pty 1.1 ships macOS prebuilds whose `spawn-helper` sometimes loses the
// executable bit when installed through pnpm, which surfaces at runtime as
// "posix_spawnp failed". Restore it after every install. No-op elsewhere.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

try {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const dirs = [join(root, 'build', 'Release')];
  const prebuilds = join(root, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const d of readdirSync(prebuilds)) dirs.push(join(prebuilds, d));
  }
  for (const d of dirs) {
    const helper = join(d, 'spawn-helper');
    if (existsSync(helper)) {
      const mode = statSync(helper).mode;
      chmodSync(helper, mode | 0o111);
      console.log(`[vatra] chmod +x ${helper}`);
    }
  }
} catch (err) {
  console.warn('[vatra] could not fix node-pty spawn-helper:', err?.message ?? err);
}
