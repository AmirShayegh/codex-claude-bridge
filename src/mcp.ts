import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

function createServerOrExit(): McpServer {
  try {
    return createServer();
  } catch (e) {
    // Print just the message (no stack) for known startup failures like
    // CONFIG_ERROR. Unexpected runtime errors after this point still bubble
    // up to index.ts where they're console.error'd with full context.
    process.stderr.write(`[codex-bridge] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = createServerOrExit();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
