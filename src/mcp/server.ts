import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools';
import { info } from '../logger';

export function createVigilMcpServer(): McpServer {
  const server = new McpServer({
    name: 'vigilops',
    version: '1.0.0',
  });

  registerTools(server);
  info('MCP server created — 22 tools registered (14 monitoring + 8 migration)');

  return server;
}
