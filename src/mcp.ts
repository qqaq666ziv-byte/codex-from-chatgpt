import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApprovalDecision } from "./jobs.js";
import { JobManager } from "./jobs.js";

const commonDecisionSchema = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
const commandAmendmentSchema = z.object({
  acceptWithExecpolicyAmendment: z.object({
    execpolicy_amendment: z.array(z.string()),
  }),
});
const networkAmendmentSchema = z.object({
  applyNetworkPolicyAmendment: z.object({
    network_policy_amendment: z.object({
      host: z.string(),
      action: z.enum(["allow", "deny"]),
    }),
  }),
});
const permissionResponseSchema = z.object({
  permissions: z.object({
    network: z.object({ enabled: z.boolean().nullable() }).optional(),
    fileSystem: z
      .object({
        read: z.array(z.string()).nullable(),
        write: z.array(z.string()).nullable(),
        globScanMaxDepth: z.number().int().positive().optional(),
        entries: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .optional(),
  }),
  scope: z.enum(["turn", "session"]),
  strictAutoReview: z.boolean().optional(),
});
const approvalDecisionSchema = z.union([
  commonDecisionSchema,
  commandAmendmentSchema,
  networkAmendmentSchema,
  permissionResponseSchema,
]);

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function success(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: jsonText(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const value = { status: "failed", error: message };
  return {
    isError: true,
    content: [{ type: "text" as const, text: jsonText(value) }],
    structuredContent: value,
  };
}

export function createMcpServer(manager: JobManager): McpServer {
  const server = new McpServer({ name: "Codex Agent", version: "0.1.0" });

  server.registerTool(
    "codex_start",
    {
      title: "Start Codex task",
      description:
        "Crea un thread persistente de Codex en un workspace local permitido y comienza un turn. No expone shell ni filesystem al cliente MCP.",
      inputSchema: {
        workspace: z.string().min(1).describe("Ruta absoluta bajo /Users/joseanu/workspace."),
        prompt: z.string().min(1).describe("Instrucción para Codex."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ workspace, prompt }) => {
      try {
        return success(await manager.start(workspace, prompt));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_continue",
    {
      title: "Continue Codex task",
      description: "Envía otro prompt al mismo thread de Codex identificado por job_id.",
      inputSchema: {
        job_id: z.string().min(1),
        prompt: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ job_id, prompt }) => {
      try {
        return success(await manager.continue(job_id, prompt));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_get",
    {
      title: "Get Codex task",
      description:
        "Devuelve un resumen compacto del job: estado, thread/turn, respuesta final, diff, archivos, comandos relevantes, error y approval pendiente.",
      inputSchema: { job_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ job_id }) => {
      try {
        return success(manager.get(job_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_interrupt",
    {
      title: "Interrupt Codex task",
      description: "Interrumpe el turn activo del job usando turn/interrupt del app-server real.",
      inputSchema: { job_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ job_id }) => {
      try {
        return success(await manager.interrupt(job_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "codex_respond_approval",
    {
      title: "Respond to Codex approval",
      description:
        "Responde una approval pendiente emitida por app-server. Las decisiones son únicamente las del schema generado por Codex 0.147.0.",
      inputSchema: {
        job_id: z.string().min(1),
        decision: approvalDecisionSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ job_id, decision }) => {
      try {
        return success(await manager.respondApproval(job_id, decision as ApprovalDecision));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
