// Monkey-patch child_process.spawn so the amp CLI is always launched with
// --stream-json-thinking instead of --stream-json. The Amp SDK
// (@sourcegraph/amp-sdk) hard-codes --stream-json and exposes no option to
// enable thinking blocks; without -thinking, Amp never emits `thinking`
// content blocks and our agent_thought_chunk path is dead.
import child_process from 'node:child_process';

const originalSpawn = child_process.spawn;

function patchArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let patched = false;
  for (const a of args) {
    if (a === '--stream-json') {
      out.push('--stream-json-thinking');
      patched = true;
    } else {
      out.push(a);
    }
  }
  // Remove any duplicate --stream-json that snuck in elsewhere.
  if (patched && out.filter((a) => a === '--stream-json' || a === '--stream-json-thinking').length > 1) {
    let seen = false;
    return out.filter((a) => {
      if (a === '--stream-json' || a === '--stream-json-thinking') {
        if (seen) return false;
        seen = true;
      }
      return true;
    });
  }
  return out;
}

(child_process as { spawn: (...a: unknown[]) => unknown }).spawn = function patchedSpawn(...args: unknown[]) {
  // child_process.spawn(command, args?, options?). Patch args[1] if it contains
  // --stream-json regardless of the command (amp may be invoked via npx, node,
  // or directly).
  if (Array.isArray(args[1]) && (args[1] as string[]).includes('--stream-json')) {
    args[1] = patchArgs(args[1] as string[]);
  }
  return (originalSpawn as (...a: unknown[]) => unknown)(...args);
};
