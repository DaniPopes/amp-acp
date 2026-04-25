// Shared credential loading used by both the entrypoint (which seeds
// AMP_API_KEY at startup) and the authenticate() handler (which re-reads
// after a successful `--setup` flow ran in a separate terminal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getConfigDir(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'amp-acp',
    );
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'amp-acp');
}

export function getCredentialsPath(): string {
  return path.join(getConfigDir(), 'credentials.json');
}

export function loadStoredApiKey(): string | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf-8')) as { apiKey?: string };
    return data.apiKey || undefined;
  } catch {
    return undefined;
  }
}
