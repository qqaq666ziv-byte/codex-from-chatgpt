import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { CodexAppServer } from "./codex-app-server.js";
import { JobManager } from "./jobs.js";
import { createMcpServer } from "./mcp.js";

const serviceName = "Codex Agent";
const host = process.env.HOST ?? "127.0.0.1";
const port = parsePort(process.env.PORT ?? "8787");

type Session = {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
};

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`PORT inválido: ${value}`);
  }
  return parsed;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const maxBytes = 2 * 1024 * 1024;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error("cuerpo MCP demasiado grande.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (body.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(body);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) {
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

async function main(): Promise<void> {
  const appServer = new CodexAppServer();
  const jobs = new JobManager(appServer);
  const sessions = new Map<string, Session>();

  const handleMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const sessionId = headerValue(request, "mcp-session-id");

    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : "JSON inválido.";
        writeJson(response, 400, { jsonrpc: "2.0", error: { code: -32700, message }, id: null });
        return;
      }

      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session && !sessionId && isInitializeRequest(body)) {
        let transport: StreamableHTTPServerTransport;
        const server = createMcpServer(jobs);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, server });
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) {
            sessions.delete(closedSessionId);
          }
        };
        await server.connect(transport);
        session = { transport, server };
      }

      if (!session) {
        writeJson(response, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Se requiere un mcp-session-id válido." },
          id: null,
        });
        return;
      }

      await session.transport.handleRequest(request, response, body);
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      if (!sessionId) {
        writeJson(response, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "GET/DELETE requieren mcp-session-id." },
          id: null,
        });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        writeJson(response, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Sesión MCP no encontrada." }, id: null });
        return;
      }
      await session.transport.handleRequest(request, response);
      return;
    }

    response.setHeader("Allow", "GET, POST, DELETE");
    writeJson(response, 405, { jsonrpc: "2.0", error: { code: -32601, message: "Método HTTP no permitido." }, id: null });
  };

  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/healthz") {
        writeJson(response, 200, { ok: true, service: serviceName });
        return;
      }
      if (url.pathname === "/readyz") {
        const alive = appServer.isAlive();
        const initialized = appServer.isReady();
        writeJson(response, initialized ? 200 : 503, {
          ready: initialized,
          service: serviceName,
          app_server_alive: alive,
          app_server_initialized: initialized,
        });
        return;
      }
      if (url.pathname === "/mcp") {
        await handleMcp(request, response);
        return;
      }
      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error interno.";
      if (!response.headersSent) {
        writeJson(response, 500, { jsonrpc: "2.0", error: { code: -32603, message }, id: null });
      }
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[${serviceName}] cerrando por ${signal}`);
    for (const session of sessions.values()) {
      try {
        await session.transport.close();
      } catch {
        // Best effort during process shutdown.
      }
    }
    await appServer.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));

  httpServer.listen(port, host, () => {
    console.error(`[${serviceName}] MCP Streamable HTTP en http://${host}:${port}/mcp`);
  });

  void appServer.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${serviceName}] app-server no está listo: ${message}`);
  });
}

void main();
