import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools';
import { info } from '../logger';

export function createVigilMcpServer(): McpServer {
  const server = new McpServer({
    name: 'vigilops',
    version: '1.0.0',
  });

  registerTools(server);
  info('MCP server ready');

  return server;
}
