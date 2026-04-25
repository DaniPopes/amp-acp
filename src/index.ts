#!/usr/bin/env node
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import './patch-amp-sdk.js';
import fs from 'node:fs';
import readline from 'node:readline';
import { runAcp } from './run-acp.js';
import { getConfigDir, getCredentialsPath, loadStoredApiKey } from './credentials.js';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function setup(): Promise<void> {
  const existing = process.env.AMP_API_KEY || loadStoredApiKey();
  if (existing) {
    console.error('AMP API key is already configured.');
    process.exit(0);
  }

  console.error('You can get your API key from: https://ampcode.com/settings');
  const apiKey = await prompt('Paste your AMP API key: ');
  if (!apiKey) {
    console.error('No API key provided. Aborting.');
    process.exit(1);
  }

  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  const credPath = getCredentialsPath();
  fs.writeFileSync(credPath, JSON.stringify({ apiKey }, null, 2) + '\n', { mode: 0o600 });

  console.error(`API key saved to ${credPath}`);
  process.exit(0);
}

if (process.argv.includes('--setup')) {
  await setup();
} else {
  if (!process.env.AMP_API_KEY) {
    const stored = loadStoredApiKey();
    if (stored) {
      process.env.AMP_API_KEY = stored;
    }
  }

  const { connection, agent } = runAcp();

  async function shutdown(): Promise<void> {
    try {
      await agent.dispose();
    } catch (err) {
      console.error('Error during cleanup:', err);
    }
    process.exit(0);
  }

  // Exit cleanly when the ACP connection closes (e.g. stdin EOF, transport
  // error). Without this, `process.stdin.resume()` keeps the event loop alive
  // indefinitely and any active amp subprocesses get orphaned.
  connection.closed.then(shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stdin.resume();
}
