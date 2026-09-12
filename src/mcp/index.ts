import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createVigilMcpServer } from './server';
import { info, error } from '../logger';

const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3200', 10);
const MCP_MODE = process.env.MCP_MODE ?? 'stdio';

async function startStdio(): Promise<void> {
  info('Starting MCP server on stdio transport...');
  const server = createVigilMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  info('MCP stdio server connected — waiting for client');
}

async function startHttp(): Promise<void> {
  const express = (await import('express')).default;
  const { randomUUID } = await import('crypto');

  const app = express();
  app.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }

      // New session — create transport + server
      const server = createVigilMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          info(`[mcp-http] Session initialized: ${sid}`);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
        info(`[mcp-http] Session closed: ${sid}`);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      error('[mcp-http] POST error', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'vigil-mcp' });
  });

  app.listen(MCP_PORT, '0.0.0.0', () => {
    info(`MCP HTTP server listening on port ${MCP_PORT}`);
    info(`MCP endpoint: http://0.0.0.0:${MCP_PORT}/mcp`);
  });
}

async function main(): Promise<void> {
  info(`Vigil MCP Server starting (mode: ${MCP_MODE})`);

  if (MCP_MODE === 'http' || MCP_MODE === 'both') {
    await startHttp();
  }

  if (MCP_MODE === 'stdio' || MCP_MODE === 'both') {
    await startStdio();
  }
}

main().catch((err) => {
  error('Failed to start MCP server', err);
  process.exit(1);
});
