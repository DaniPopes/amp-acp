#!/usr/bin/env node
// Post-build patch for dist/index.js.
//
// The Amp SDK's `buildSettingsFile()` writes a settings.json under
// `<cwd>/.tmp/sdk-<id>/` on every `execute()` call, even when the contents
// would be empty — because `AmpOptionsSchema` defaults `mode` to `"smart"`,
// and `mode` is one of the trigger fields that gates file creation, so the
// trigger always fires regardless of what we pass in AmpOptions.
//
// There is no AmpOptions escape hatch and runtime monkey-patching is
// impossible because `bun build` inlines the SDK source into dist/index.js.
// The least-bad fix is to rewrite the offending line in the bundle itself
// after building, redirecting the temp dir to `os.tmpdir()`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'index.js',
);

const src = fs.readFileSync(distPath, 'utf8');
if (src.includes('amp-acp:tmpdir-redirect')) {
  process.exit(0);
}

// Find the line; the bundler renames `path` to `path2`, `path3`, etc.
// Capture the path identifier so we can reuse it (and assume `os` is bound
// in the same scope — the SDK imports both at the top of its module).
const NEEDLE_RE = /const tempDir = (path\d*)\.join\(cwd, "\.tmp", sessionId\);/;
const match = src.match(NEEDLE_RE);
if (!match) {
  console.error(
    '[patch-bundled-sdk] tempDir needle not found in dist/index.js — amp-sdk internals may have changed',
  );
  process.exit(1);
}
const pathId = match[1];
// `os` in the SDK's module is renamed by bun's bundler. Find what it is by
// looking near the SDK's top-level imports for an alias of "node:os".
const osAliasMatch = src.match(/import (\w+) from ["']node:os["']/g) ?? [];
// Pick whichever alias appears closest BEFORE the needle (the SDK's local
// binding). Fall back to "os" if we can't determine it.
let osId = 'os';
const needleIdx = match.index ?? 0;
let bestIdx = -1;
for (const stmt of osAliasMatch) {
  const idx = src.indexOf(stmt);
  if (idx >= 0 && idx < needleIdx && idx > bestIdx) {
    bestIdx = idx;
    const m = stmt.match(/import (\w+) from/);
    if (m) osId = m[1];
  }
}

// Also kill the buildSettingsFile early-return guard. Without this, the
// SDK still writes an empty settings.json and passes it to amp via
// `--settings-file`, which **overrides** the user's global
// ~/.config/amp/settings.json (so e.g. skip-all-permissions stops working).
// Force the early return by inverting the guard so we always return null
// and never write a file.
const GUARD_RE = /if \(!settingsFields\.some\(Boolean\)\) \{/;
let patched = src;
if (GUARD_RE.test(patched)) {
  patched = patched.replace(GUARD_RE, 'if (true) {');
} else {
  console.error(
    '[patch-bundled-sdk] settings-file guard not found in dist/index.js — amp-sdk internals may have changed',
  );
  process.exit(1);
}

// Even though the early-return now fires unconditionally and the tempDir
// line is unreachable, still rewrite it so future SDK changes don't
// silently regress on workspace pollution.
const REPLACEMENT = `const tempDir = ${pathId}.join(${osId}.tmpdir(), "amp-acp-sdk-tmp", sessionId); /* amp-acp:tmpdir-redirect */`;
patched = patched.replace(NEEDLE_RE, REPLACEMENT);

fs.writeFileSync(distPath, patched, 'utf8');
console.log(
  `[patch-bundled-sdk] disabled SDK settings-file generation; redirected tempDir to ${osId}.tmpdir() (path=${pathId})`,
);
