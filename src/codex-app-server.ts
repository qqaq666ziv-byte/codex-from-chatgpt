import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { InitializeParams } from "../protocol/codex-0.147.0-ts/InitializeParams.js";

export type JsonRpcId = string | number;
export type JsonObject = Record<string, unknown>;

export type AppServerMessage = JsonObject & {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export class AppServerError extends Error {
  readonly code: number | string | null;
  readonly data: unknown;

  constructor(message: string, code: number | string | null = null, data: unknown = null) {
    super(message);
    this.name = "AppServerError";
    this.code = code;
    this.data = data;
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type MessageListener = (message: AppServerMessage) => void;
type ExitListener = (error: Error) => void;

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFromRpc(value: unknown): AppServerError {
  if (!isObject(value)) {
    return new AppServerError("app-server devolvió un error sin detalle.");
  }

  const rawCode = value.code;
  const code = typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : null;
  const message = typeof value.message === "string" ? value.message : "Error de app-server.";
  return new AppServerError(message, code, value.data ?? null);
}

export class CodexAppServer {
  private readonly command: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private lineBuffer = "";
  private initialized = false;
  private intentionalStop = false;
  private exitNotified = false;
  private startPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private stderrTail = "";

  constructor(command = process.env.CODEX_BIN ?? "codex") {
    this.command = command;
  }

  addMessageListener(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  addExitListener(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  isReady(): boolean {
    return this.isAlive() && this.initialized;
  }

  getLastError(): string | null {
    return this.stderrTail.length > 0 ? this.stderrTail : null;
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    this.intentionalStop = false;
    this.exitNotified = false;
    this.initialized = false;
    this.lineBuffer = "";

    const child = spawn(this.command, ["app-server", "--stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Consume stderr so a noisy local Codex process cannot block on a full
      // pipe. It is intentionally never returned by an MCP tool.
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
    });

    child.once("error", (error) => this.failAll(new Error(`No se pudo iniciar codex app-server: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (this.intentionalStop) {
        return;
      }
      const suffix = signal ? `señal ${signal}` : `código ${code ?? "desconocido"}`;
      this.failAll(new Error(`codex app-server terminó inesperadamente (${suffix}).`));
    });

    const initializeParams: InitializeParams = {
      clientInfo: {
        name: "codex-agent-mcp",
        title: "Codex Agent",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    };

    await this.request("initialize", initializeParams);
    this.sendNotification("initialized");
    this.initialized = true;
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.isAlive()) {
      throw new AppServerError("codex app-server no está vivo.");
    }

    const id = this.nextId++;
    const key = idKey(id);
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(key, { resolve: resolve as (value: unknown) => void, reject });
    });

    try {
      this.writeMessage(params === undefined ? { id, method } : { id, method, params });
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }

    return promise;
  }

  sendNotification(method: string, params?: unknown): void {
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.writeMessage({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    this.initialized = false;
    const child = this.child;
    if (!child) {
      return;
    }

    const error = new AppServerError("codex app-server detenido por el servidor MCP.");
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();

    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  private writeMessage(message: JsonObject): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new AppServerError("codex app-server no acepta nuevos mensajes.");
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: string): void {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.consumeLine(line);
      }
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // app-server's stdout is the JSONL protocol. Ignore malformed lines so
      // one bad diagnostic cannot crash the bridge; stderr remains diagnostic.
      return;
    }

    if (!isObject(parsed)) {
      return;
    }

    const message = parsed as AppServerMessage;
    if (typeof message.method !== "string" && (typeof message.id === "number" || typeof message.id === "string")) {
      const pending = this.pending.get(idKey(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(idKey(message.id));
      if ("error" in message) {
        pending.reject(errorFromRpc(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  private failAll(error: Error): void {
    this.initialized = false;
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();

    if (!this.exitNotified) {
      this.exitNotified = true;
      for (const listener of this.exitListeners) {
        listener(error);
      }
    }
  }
}
