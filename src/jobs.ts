import { randomUUID } from "node:crypto";

import type { CommandExecutionApprovalDecision } from "../protocol/codex-0.147.0-ts/v2/CommandExecutionApprovalDecision.js";
import type { FileChangeApprovalDecision } from "../protocol/codex-0.147.0-ts/v2/FileChangeApprovalDecision.js";
import type { PermissionsRequestApprovalResponse } from "../protocol/codex-0.147.0-ts/v2/PermissionsRequestApprovalResponse.js";
import type { ThreadStartParams } from "../protocol/codex-0.147.0-ts/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "../protocol/codex-0.147.0-ts/v2/ThreadStartResponse.js";
import type { TurnInterruptParams } from "../protocol/codex-0.147.0-ts/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "../protocol/codex-0.147.0-ts/v2/TurnStartParams.js";
import type { TurnStartResponse } from "../protocol/codex-0.147.0-ts/v2/TurnStartResponse.js";
import type { UserInput } from "../protocol/codex-0.147.0-ts/v2/UserInput.js";

import { AppServerError, type AppServerMessage, type JsonObject, type JsonRpcId, CodexAppServer } from "./codex-app-server.js";
import { validateWorkspace } from "./workspaces.js";

export type JobStatus =
  | "starting"
  | "running"
  | "awaiting_approval"
  | "interrupting"
  | "completed"
  | "interrupted"
  | "failed";

export type CommonApprovalDecision = FileChangeApprovalDecision;
export type ApprovalDecision =
  | CommandExecutionApprovalDecision
  | FileChangeApprovalDecision
  | PermissionsRequestApprovalResponse;

type ApprovalKind = "command_execution" | "file_change" | "permissions";

const CODEX_MODEL = "gpt-5.6-luna";
const CODEX_REASONING_EFFORT = "high";

type PendingApproval = {
  requestId: JsonRpcId;
  kind: ApprovalKind;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  params: JsonObject;
};

type JobRecord = {
  jobId: string;
  threadId: string;
  workspace: string;
  turnId: string | null;
  status: JobStatus;
  finalMessage: string | null;
  latestDiff: string | null;
  filesChanged: string[];
  commandsExecuted: string[];
  error: string | null;
  pendingApproval: PendingApproval | null;
  lastAgentMessage: string | null;
  agentMessages: Map<string, { text: string; phase: string | null }>;
};

export type PendingApprovalView = {
  request_id: JsonRpcId;
  kind: ApprovalKind;
  method: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  grant_root: string | null;
  permissions: unknown | null;
  decision_values: string[];
};

export type JobSnapshot = {
  status: JobStatus;
  job_id: string;
  thread_id: string;
  turn_id: string | null;
  final_message: string | null;
  latest_diff: string | null;
  files_changed: string[];
  commands_executed: string[];
  error: string | null;
  pending_approval: PendingApprovalView | null;
};

export type JobStartResult = Pick<JobSnapshot, "job_id" | "thread_id" | "turn_id" | "status">;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppServerError(`app-server devolvió una respuesta inválida: falta ${label}.`);
  }
  return value;
}

function paramsForMessage(message: AppServerMessage): JsonObject | null {
  return isObject(message.params) ? message.params : null;
}

function commonDecision(value: unknown): value is CommonApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isApprovalDecisionFor(kind: ApprovalKind, value: unknown): value is ApprovalDecision {
  if (kind === "file_change") {
    return commonDecision(value);
  }

  if (kind === "permissions") {
    if (!isObject(value) || !isObject(value.permissions)) {
      return false;
    }
    return value.scope === "turn" || value.scope === "session";
  }

  if (commonDecision(value)) {
    return true;
  }

  if (!isObject(value)) {
    return false;
  }

  const execpolicy = value.acceptWithExecpolicyAmendment;
  if (isObject(execpolicy) && Array.isArray(execpolicy.execpolicy_amendment)) {
    return execpolicy.execpolicy_amendment.every((entry) => typeof entry === "string");
  }

  const network = value.applyNetworkPolicyAmendment;
  if (!isObject(network) || !isObject(network.network_policy_amendment)) {
    return false;
  }
  const amendment = network.network_policy_amendment;
  return typeof amendment.host === "string" && (amendment.action === "allow" || amendment.action === "deny");
}

function approvalView(approval: PendingApproval): PendingApprovalView {
  const params = approval.params;
  const decisionValues =
    approval.kind === "permissions"
      ? ["permissions"]
      : approval.kind === "file_change"
        ? ["accept", "acceptForSession", "decline", "cancel"]
        : [
            "accept",
            "acceptForSession",
            "acceptWithExecpolicyAmendment",
            "applyNetworkPolicyAmendment",
            "decline",
            "cancel",
          ];

  return {
    request_id: approval.requestId,
    kind: approval.kind,
    method: approval.method,
    thread_id: approval.threadId,
    turn_id: approval.turnId,
    item_id: approval.itemId,
    command: stringValue(params.command),
    cwd: stringValue(params.cwd),
    reason: stringValue(params.reason),
    grant_root: stringValue(params.grantRoot),
    permissions: params.permissions ?? null,
    decision_values: decisionValues,
  };
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly jobsByThread = new Map<string, string>();

  constructor(private readonly appServer: CodexAppServer) {
    appServer.addMessageListener((message) => this.handleAppServerMessage(message));
    appServer.addExitListener((error) => this.handleAppServerExit(error));
  }

  async start(workspace: string, prompt: string): Promise<JobStartResult> {
    const canonicalWorkspace = await validateWorkspace(workspace);
    if (prompt.trim().length === 0) {
      throw new Error("prompt no puede estar vacío.");
    }

    await this.appServer.start();

    const startParams: ThreadStartParams = {
      model: CODEX_MODEL,
      cwd: canonicalWorkspace,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    };
    const response = await this.appServer.request<ThreadStartResponse>("thread/start", startParams);
    const thread = isObject(response) && isObject(response.thread) ? response.thread : null;
    const threadId = requiredString(thread?.id, "thread.id");
    const jobId = randomUUID();
    const job: JobRecord = {
      jobId,
      threadId,
      workspace: canonicalWorkspace,
      turnId: null,
      status: "starting",
      finalMessage: null,
      latestDiff: null,
      filesChanged: [],
      commandsExecuted: [],
      error: null,
      pendingApproval: null,
      lastAgentMessage: null,
      agentMessages: new Map(),
    };
    this.jobs.set(jobId, job);
    this.jobsByThread.set(threadId, jobId);

    try {
      await this.startTurn(job, prompt);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      throw error;
    }

    return {
      job_id: job.jobId,
      thread_id: job.threadId,
      turn_id: job.turnId,
      status: job.status,
    };
  }

  async continue(jobId: string, prompt: string): Promise<JobStartResult> {
    const job = this.getJob(jobId);
    if (prompt.trim().length === 0) {
      throw new Error("prompt no puede estar vacío.");
    }
    if (this.isActive(job)) {
      throw new Error("el job ya tiene un turn activo; usa codex_get o codex_interrupt.");
    }

    await this.appServer.start();
    await this.startTurn(job, prompt);
    return {
      job_id: job.jobId,
      thread_id: job.threadId,
      turn_id: job.turnId,
      status: job.status,
    };
  }

  async interrupt(jobId: string): Promise<JobSnapshot> {
    const job = this.getJob(jobId);
    if (!this.isActive(job) || job.turnId === null) {
      throw new Error("el job no tiene un turn activo que interrumpir.");
    }

    const params: TurnInterruptParams = {
      threadId: job.threadId,
      turnId: job.turnId,
    };
    await this.appServer.request("turn/interrupt", params);
    job.status = "interrupting";
    return this.snapshot(job);
  }

  async respondApproval(jobId: string, decision: ApprovalDecision): Promise<JobSnapshot> {
    const job = this.getJob(jobId);
    const approval = job.pendingApproval;
    if (!approval) {
      throw new Error("el job no tiene una approval pendiente.");
    }
    if (!isApprovalDecisionFor(approval.kind, decision)) {
      throw new Error(`decision no admitida para una approval de tipo ${approval.kind}.`);
    }

    const result = approval.kind === "permissions" ? decision : { decision };
    this.appServer.respond(approval.requestId, result);
    job.pendingApproval = null;
    if (job.status === "awaiting_approval") {
      job.status = "running";
    }
    return this.snapshot(job);
  }

  get(jobId: string): JobSnapshot {
    return this.snapshot(this.getJob(jobId));
  }

  private async startTurn(job: JobRecord, prompt: string): Promise<void> {
    this.resetTurn(job);
    const input: UserInput[] = [{ type: "text", text: prompt, text_elements: [] }];
    const params: TurnStartParams = {
      threadId: job.threadId,
      input,
      model: CODEX_MODEL,
      effort: CODEX_REASONING_EFFORT,
    };
    const response = await this.appServer.request<TurnStartResponse>("turn/start", params);
    const turn = isObject(response) && isObject(response.turn) ? response.turn : null;
    job.turnId = requiredString(turn?.id, "turn.id");
    const status = turn?.status;
    job.status = status === "completed" ? "completed" : status === "failed" ? "failed" : "running";
    if (status === "failed" && isObject(turn?.error)) {
      job.error = stringValue(turn.error.message) ?? "El turn falló.";
    }
  }

  private resetTurn(job: JobRecord): void {
    job.turnId = null;
    job.status = "starting";
    job.finalMessage = null;
    job.latestDiff = null;
    job.filesChanged = [];
    job.commandsExecuted = [];
    job.error = null;
    job.pendingApproval = null;
    job.lastAgentMessage = null;
    job.agentMessages.clear();
  }

  private handleAppServerMessage(message: AppServerMessage): void {
    const method = message.method;
    if (!method) {
      return;
    }

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      this.handleApprovalRequest(message, method);
      return;
    }

    const params = paramsForMessage(message);
    if (!params) {
      return;
    }

    const threadId = stringValue(params.threadId);
    const job = threadId ? this.jobForThread(threadId) : null;
    if (!job) {
      return;
    }

    switch (method) {
      case "turn/started":
        this.handleTurnStarted(job, params);
        break;
      case "turn/completed":
        this.handleTurnCompleted(job, params);
        break;
      case "turn/diff/updated":
        if (typeof params.diff === "string") {
          job.latestDiff = params.diff;
        }
        break;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(job, params);
        break;
      case "item/started":
      case "item/completed":
        this.handleItem(job, params);
        break;
      case "error":
        job.status = "failed";
        job.error = stringValue(params.message) ?? "Error de app-server.";
        break;
      default:
        break;
    }
  }

  private handleApprovalRequest(
    message: AppServerMessage,
    method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval",
  ): void {
    if (typeof message.id !== "number" && typeof message.id !== "string") {
      return;
    }
    const params = paramsForMessage(message);
    if (!params) {
      this.appServer.respondError(message.id, -32602, "Approval sin params válidos.");
      return;
    }

    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const itemId = stringValue(params.itemId);
    const job = threadId ? this.jobForThread(threadId) : null;
    if (threadId === null || !job || !turnId || !itemId) {
      this.appServer.respondError(message.id, -32001, "No existe un job local para esta approval.");
      return;
    }

    const kind: ApprovalKind =
      method === "item/commandExecution/requestApproval"
        ? "command_execution"
        : method === "item/fileChange/requestApproval"
          ? "file_change"
          : "permissions";

    job.pendingApproval = {
      requestId: message.id,
      kind,
      method,
      threadId,
      turnId,
      itemId,
      params,
    };
    job.status = "awaiting_approval";
  }

  private handleTurnStarted(job: JobRecord, params: JsonObject): void {
    const turn = isObject(params.turn) ? params.turn : null;
    const turnId = stringValue(turn?.id);
    if (turnId) {
      job.turnId = turnId;
    }
    job.status = "running";
  }

  private handleTurnCompleted(job: JobRecord, params: JsonObject): void {
    const turn = isObject(params.turn) ? params.turn : null;
    if (turn) {
      const turnId = stringValue(turn.id);
      if (turnId) {
        job.turnId = turnId;
      }
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) {
          if (isObject(item)) {
            this.recordItem(job, item);
          }
        }
      }
    }

    const status = turn?.status;
    if (status === "completed") {
      job.status = "completed";
      job.finalMessage = this.finalMessage(job);
      job.pendingApproval = null;
      return;
    }
    if (status === "interrupted") {
      job.status = "interrupted";
      job.finalMessage = null;
      job.pendingApproval = null;
      return;
    }
    if (status === "failed") {
      job.status = "failed";
      job.error = isObject(turn?.error)
        ? stringValue(turn.error.message) ?? "El turn falló."
        : "El turn falló.";
      job.pendingApproval = null;
    }
  }

  private handleAgentMessageDelta(job: JobRecord, params: JsonObject): void {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (!itemId || delta === null) {
      return;
    }
    const current = job.agentMessages.get(itemId) ?? { text: "", phase: null };
    current.text += delta;
    job.agentMessages.set(itemId, current);
    job.lastAgentMessage = current.text;
  }

  private handleItem(job: JobRecord, params: JsonObject): void {
    const item = isObject(params.item) ? params.item : null;
    if (item) {
      this.recordItem(job, item);
    }
  }

  private recordItem(job: JobRecord, item: JsonObject): void {
    const type = item.type;
    if (type === "agentMessage") {
      const id = stringValue(item.id);
      const text = stringValue(item.text);
      if (!id || text === null) {
        return;
      }
      const phase = stringValue(item.phase);
      job.agentMessages.set(id, { text, phase });
      job.lastAgentMessage = text;
      if (phase === "final_answer") {
        job.finalMessage = text;
      }
      return;
    }

    if (type === "commandExecution") {
      const command = stringValue(item.command);
      const status = stringValue(item.status);
      if (command && (status === "completed" || status === "failed") && !job.commandsExecuted.includes(command)) {
        job.commandsExecuted.push(command);
      }
      return;
    }

    if (type === "fileChange" && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (!isObject(change)) {
          continue;
        }
        const filePath = stringValue(change.path);
        if (filePath && !job.filesChanged.includes(filePath)) {
          job.filesChanged.push(filePath);
        }
      }
    }
  }

  private finalMessage(job: JobRecord): string | null {
    for (const message of job.agentMessages.values()) {
      if (message.phase === "final_answer") {
        return message.text;
      }
    }
    return job.finalMessage ?? job.lastAgentMessage;
  }

  private handleAppServerExit(error: Error): void {
    for (const job of this.jobs.values()) {
      if (this.isActive(job)) {
        job.status = "failed";
        job.error = error.message;
        job.pendingApproval = null;
      }
    }
  }

  private isActive(job: JobRecord): boolean {
    return job.status === "starting" || job.status === "running" || job.status === "awaiting_approval" || job.status === "interrupting";
  }

  private jobForThread(threadId: string): JobRecord | null {
    const jobId = this.jobsByThread.get(threadId);
    return jobId ? this.jobs.get(jobId) ?? null : null;
  }

  private getJob(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`job_id desconocido: ${jobId}`);
    }
    return job;
  }

  private snapshot(job: JobRecord): JobSnapshot {
    return {
      status: job.status,
      job_id: job.jobId,
      thread_id: job.threadId,
      turn_id: job.turnId,
      final_message: job.finalMessage,
      latest_diff: job.latestDiff,
      files_changed: [...job.filesChanged],
      commands_executed: [...job.commandsExecuted],
      error: job.error,
      pending_approval: job.pendingApproval ? approvalView(job.pendingApproval) : null,
    };
  }
}
