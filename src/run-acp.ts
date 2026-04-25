import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { nodeToWebWritable, nodeToWebReadable } from './utils.js';
import { AmpAcpAgent } from './server.js';

export function runAcp(): { connection: AgentSideConnection; agent: AmpAcpAgent } {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(
    input as unknown as WritableStream<Uint8Array>,
    output as unknown as ReadableStream<Uint8Array>,
  );
  let agent!: AmpAcpAgent;
  const connection = new AgentSideConnection((client) => {
    agent = new AmpAcpAgent(client);
    return agent;
  }, stream);
  return { connection, agent };
}
