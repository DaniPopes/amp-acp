// The Amp SDK (@sourcegraph/amp-sdk) hard-codes --stream-json (without the
// -thinking suffix) when launching the Amp CLI, and exposes no option to
// enable thinking blocks. Without -thinking, Amp never emits `thinking`
// content blocks and our agent_thought_chunk path is dead.
//
// Monkey-patching child_process.spawn does NOT work: the SDK uses ESM named
// imports (`import { spawn } from 'node:child_process'`) which snapshot the
// original `spawn` at import time, so mutating `child_process.spawn` later
// has no effect on the SDK's binding.
//
// Instead we use the SDK's officially supported `AMP_CLI_PATH` env var (see
// resolveCliFromEnvironment in @sourcegraph/amp-sdk) to point at a wrapper
// script that swaps --stream-json for --stream-json-thinking before
// invoking the real `amp` from PATH.
//
// (Note: the SDK's `buildSettingsFile()` writing `<cwd>/.tmp/sdk-*/` is
// patched out separately at build time by `scripts/patch-bundled-sdk.mjs`,
// not at runtime, because the SDK source is inlined into dist/index.js by
// the bundler.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WRAPPER_SOURCE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2).map((a) => (a === '--stream-json' ? '--stream-json-thinking' : a));
const child = spawn('amp', args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
`;

function installAmpCliWrapper(): void {
  if (process.env.AMP_CLI_PATH) return;
  const wrapperPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'amp-acp-shim-')), 'amp-thinking.mjs');
  fs.writeFileSync(wrapperPath, WRAPPER_SOURCE, { mode: 0o755 });
  process.env.AMP_CLI_PATH = wrapperPath;
}

installAmpCliWrapper();
