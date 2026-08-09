import { randomUUID } from "node:crypto";

import type { CommandExecutionApprovalDecision } from "../protocol/codex-0.147.0-ts/v2/CommandExecutionApprovalDecision.js";
import type { FileChangeApprovalDecision } from "../protocol/codex-0.147.0-ts/v2/FileChangeApprovalDecision.js";
import type { PermissionsRequestApprovalResponse } from "../protocol/codex-0.147.0-ts/v2/PermissionsRequestApprovalResponse.js";
import type { ReviewDecision } from "../protocol/codex-0.147.0-ts/ReviewDecision.js";
import type { ThreadStartParams } from "../protocol/codex-0.147.0-ts/v2/ThreadStartParams.js";
import type { TurnStartParams } from "../protocol/codex-0.147.0-ts/v2/TurnStartParams.js";

import { AppServerError, type AppServerClient, type AppServerMessage, type JsonObject, type JsonRpcId } from "./codex-app-server.js";
import { StateStore, type PersistedJob } from "./store.js";
import { validateWorkspace } from "./workspaces.js";

export type JobStatus =
  | "starting"
  | "running"
  | "awaiting_approval"
  | "interrupting"
  | "completed"
  | "interrupted"
  | "failed"
  | "recovery_required";

export type ApprovalDecision =
  | CommandExecutionApprovalDecision
  | FileChangeApprovalDecision
  | PermissionsRequestApprovalResponse
  | ReviewDecision;

type ApprovalKind = "command_execution" | "file_change" | "permissions";

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
  threadId: string | null;
  workspace: string;
  turnId: string | null;
  status: JobStatus;
  finalMessage: string | null;
  latestDiff: string | null;
  filesChanged: string[];
  commandsExecuted: string[];
  error: string | null;
  pendingApprovals: Map<string, PendingApproval>;
  lastAgentMessage: string | null;
  agentMessages: Map<string, { text: string; phase: string | null }>;
  updatedAt: string;
};

type TurnCapture = {
  jobId: string;
  threadId: string;
  turnId: string | null;
  buffered: AppServerMessage[];
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
  thread_id: string | null;
  turn_id: string | null;
  final_message: string | null;
  latest_diff: string | null;
  files_changed: string[];
  commands_executed: string[];
  error: string | null;
  pending_approval: PendingApprovalView | null;
  pending_approvals: PendingApprovalView[];
};

export type JobStartResult = Pick<JobSnapshot, "job_id" | "thread_id" | "turn_id" | "status">;

export type JobManagerOptions = {
  store?: StateStore;
  model?: string;
  reasoningEffort?: string;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatProtocolError(value: unknown, fallback = "Error de app-server."): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    if (isObject(value) && typeof value.message === "string") return `${value.message} | ${serialized}`;
    return serialized ?? fallback;
  } catch {
    return fallback;
  }
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

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function commonDecision(value: unknown): value is FileChangeApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function isApprovalDecisionFor(kind: ApprovalKind, value: unknown): value is ApprovalDecision {
  if (kind === "file_change") return commonDecision(value);
  if (kind === "permissions") {
    if (!isObject(value) || !isObject(value.permissions)) return false;
    const permissions = value.permissions;
    if (value.strictAutoReview !== undefined && value.strictAutoReview !== null && typeof value.strictAutoReview !== "boolean") return false;
    const scope = value.scope === undefined ? "turn" : value.scope;
    if (scope !== "turn" && scope !== "session") return false;
    if (permissions.network !== undefined && permissions.network !== null && (!isObject(permissions.network) || permissions.network.enabled !== undefined && typeof permissions.network.enabled !== "boolean" && permissions.network.enabled !== null)) return false;
    if (permissions.fileSystem !== undefined && permissions.fileSystem !== null) {
      const fileSystem = permissions.fileSystem;
      const validPathList = (value: unknown): boolean => value === undefined || value === null || Array.isArray(value) && value.every((entry) => typeof entry === "string");
      if (!isObject(fileSystem) || !validPathList(fileSystem.read) || !validPathList(fileSystem.write)) return false;
      if (fileSystem.globScanMaxDepth !== undefined && fileSystem.globScanMaxDepth !== null && (typeof fileSystem.globScanMaxDepth !== "number" || !Number.isInteger(fileSystem.globScanMaxDepth) || fileSystem.globScanMaxDepth <= 0)) return false;
      if (fileSystem.entries !== undefined && fileSystem.entries !== null && (!Array.isArray(fileSystem.entries) || !fileSystem.entries.every(isFileSystemEntry))) return false;
    }
    return true;
  }
  if (commonDecision(value)) return true;
  if (!isObject(value)) return false;
  const execpolicy = value.acceptWithExecpolicyAmendment;
  if (isObject(execpolicy) && Array.isArray(execpolicy.execpolicy_amendment)) {
    return execpolicy.execpolicy_amendment.every((entry) => typeof entry === "string");
  }
  const network = value.applyNetworkPolicyAmendment;
  if (!isObject(network) || !isObject(network.network_policy_amendment)) return false;
  const amendment = network.network_policy_amendment;
  return typeof amendment.host === "string" && (amendment.action === "allow" || amendment.action === "deny");
}

function isFileSystemEntry(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.path) || (value.access !== "read" && value.access !== "write" && value.access !== "deny")) return false;
  const pathValue = value.path;
  if (pathValue.type === "path") return typeof pathValue.path === "string";
  if (pathValue.type === "glob_pattern") return typeof pathValue.pattern === "string";
  if (pathValue.type !== "special" || !isObject(pathValue.value)) return false;
  const special = pathValue.value;
  if (special.kind === "root" || special.kind === "minimal" || special.kind === "tmpdir" || special.kind === "slash_tmp") return true;
  if (special.kind === "project_roots") return special.subpath === undefined || special.subpath === null || typeof special.subpath === "string";
  return special.kind === "unknown" && typeof special.path === "string" && (special.subpath === undefined || special.subpath === null || typeof special.subpath === "string");
}

function isLegacyApprovalDecision(value: unknown): value is ReviewDecision {
  if (value === "approved" || value === "approved_for_session" || value === "timed_out" || value === "abort") return true;
  if (!isObject(value)) return false;
  if (isObject(value.denied)) return typeof value.denied.rejection === "string";
  if (isObject(value.approved_execpolicy_amendment)) {
    const amendment = value.approved_execpolicy_amendment.proposed_execpolicy_amendment;
    return Array.isArray(amendment) && amendment.every((entry) => typeof entry === "string");
  }
  if (isObject(value.network_policy_amendment)) {
    const amendment = value.network_policy_amendment.network_policy_amendment;
    return isObject(amendment) && typeof amendment.host === "string" && (amendment.action === "allow" || amendment.action === "deny");
  }
  return false;
}

function isTerminal(status: unknown): status is "completed" | "interrupted" | "failed" {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function isActiveStatus(status: JobStatus): boolean {
  return status === "starting" || status === "running" || status === "awaiting_approval" || status === "interrupting";
}

function isAmbiguousThreadStartError(error: unknown): boolean {
  return isObject(error) && error.code === -32002;
}

function messageTurnId(message: AppServerMessage): string | null {
  const params = paramsForMessage(message);
  if (!params) return null;
  const direct = stringValue(params.turnId);
  if (direct) return direct;
  const turn = isObject(params.turn) ? params.turn : null;
  return stringValue(turn?.id);
}

function isTurnScopedMethod(method: string): boolean {
  return method === "turn/started" || method === "turn/completed" || method === "turn/diff/updated" ||
    method.startsWith("item/") || method === "error";
}

function approvalView(approval: PendingApproval): PendingApprovalView {
  const params = approval.params;
  const command = typeof params.command === "string"
    ? params.command
    : Array.isArray(params.command) && params.command.every((entry) => typeof entry === "string")
      ? params.command.join(" ")
      : null;
  const decisionValues = approval.kind === "permissions"
    ? ["permissions"]
    : approval.kind === "file_change"
      ? ["accept", "acceptForSession", "decline", "cancel"]
      : ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "applyNetworkPolicyAmendment", "decline", "cancel"];
  return {
    request_id: approval.requestId,
    kind: approval.kind,
    method: approval.method,
    thread_id: approval.threadId,
    turn_id: approval.turnId,
    item_id: approval.itemId,
    command,
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
  private readonly turnCaptures = new Map<string, TurnCapture>();
  private readonly store: StateStore;
  private readonly model: string | undefined;
  private readonly reasoningEffort: string | undefined;
  private activeJobId: string | null = null;
  private recoveryFence = false;
  private rehydrated = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly appServer: AppServerClient, options: JobManagerOptions = {}) {
    this.store = options.store ?? new StateStore();
    this.model = options.model ?? (process.env.CODEX_AGENT_MODEL?.trim() || undefined);
    this.reasoningEffort = options.reasoningEffort ?? (process.env.CODEX_AGENT_REASONING_EFFORT?.trim() || undefined);
    this.loadPersistedIndex();
    appServer.addMessageListener((message) => this.handleAppServerMessage(message));
    appServer.addExitListener((error) => this.handleAppServerExit(error));
  }

  async initialize(): Promise<void> {
    await this.withExclusive(async () => {
      await this.ensureReady();
    });
  }

  async start(workspace: string, prompt: string): Promise<JobStartResult> {
    const canonicalWorkspace = await validateWorkspace(workspace);
    this.validatePrompt(prompt);
    return this.withExclusive(async () => {
      await this.ensureReady();
      this.assertNoActiveTurn();
      const job: JobRecord = {
        jobId: randomUUID(), threadId: null, workspace: canonicalWorkspace, turnId: null, status: "starting",
        finalMessage: null, latestDiff: null, filesChanged: [], commandsExecuted: [], error: null,
        pendingApprovals: new Map(), lastAgentMessage: null, agentMessages: new Map(), updatedAt: new Date().toISOString(),
      };
      this.jobs.set(job.jobId, job);
      this.activeJobId = job.jobId;
      try {
        if (!this.persist(job, true)) throw new Error("No se pudo persistir el job antes de crear el thread.");
        const response = await this.appServer.request<unknown>("thread/start", {
          ...(this.model ? { model: this.model } : {}),
          cwd: canonicalWorkspace,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
        } satisfies ThreadStartParams);
        const thread = isObject(response) && isObject(response.thread) ? response.thread : null;
        const threadId = requiredString(thread?.id, "thread.id");
        this.attachThread(job, threadId);
        this.persist(job, true);
        await this.startTurn(job, prompt);
      } catch (error) {
        if (job.threadId === null && isAmbiguousThreadStartError(error)) {
          this.setRecoveryRequired(job, new Error(`thread/start incierto: el resultado puede haber creado un thread, pero no se adopta automáticamente (${error instanceof Error ? error.message : String(error)}).`));
        } else if (job.status !== "recovery_required") {
          // An explicit RPC rejection is definitive: no usable thread was returned.
          // Only the timeout/ambiguous result above enters recovery_required.
          this.setFailure(job, error, false);
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)} (job_id=${job.jobId})`);
      }
      return this.startResult(job);
    });
  }

  async continue(jobId: string, prompt: string): Promise<JobStartResult> {
    this.validatePrompt(prompt);
    return this.withExclusive(async () => {
      await this.ensureReady();
      const job = this.getJob(jobId);
      this.assertRecoveryFence();
      if (this.activeJobId !== null || isActiveStatus(job.status)) {
        throw new Error("backend ocupado: el job ya tiene un turn activo; usa codex_get o codex_interrupt.");
      }
      if (job.status === "recovery_required") {
        throw new Error("el job requiere reconciliación después de un fallo del app-server.");
      }
      if (job.threadId === null) throw new Error("el job aún no tiene un thread confirmado; requiere reconciliación.");
      this.activeJobId = job.jobId;
      try {
        await this.startTurn(job, prompt);
      } catch (error) {
        this.setFailure(job, error, true);
        throw error;
      }
      return this.startResult(job);
    });
  }

  async interrupt(jobId: string): Promise<JobSnapshot> {
    return this.withExclusive(async () => {
      await this.ensureReady();
      const job = this.getJob(jobId);
      if (!isActiveStatus(job.status) || job.threadId === null || job.turnId === null || this.activeJobId !== job.jobId) {
        throw new Error("el job no tiene un turn activo que interrumpir.");
      }
      try {
        const response = await this.appServer.request<unknown>("turn/interrupt", { threadId: job.threadId, turnId: job.turnId });
        const turn = isObject(response) && isObject(response.turn) ? response.turn : null;
        if (!isTerminal(job.status)) {
          if (turn && isTerminal(turn.status) && stringValue(turn.id) === job.turnId) this.applyTerminalStatus(job, turn.status, turn);
          else if (isActiveStatus(job.status)) job.status = "interrupting";
        }
        this.touch(job);
        this.persist(job, true);
        return this.snapshot(job);
      } catch (error) {
        this.setRecoveryRequired(job, error);
        throw error;
      }
    });
  }

  async respondApproval(jobId: string, requestId: JsonRpcId, decision: ApprovalDecision): Promise<JobSnapshot> {
    return this.withExclusive(async () => {
      await this.ensureReady();
      const job = this.getJob(jobId);
      const approval = job.pendingApprovals.get(idKey(requestId));
      if (!approval) throw new Error(`no existe una approval pendiente con request_id=${String(requestId)} para este job.`);
      if (!(approval.method === "applyPatchApproval" || approval.method === "execCommandApproval" ? isLegacyApprovalDecision(decision) : isApprovalDecisionFor(approval.kind, decision))) {
        throw new Error(`decision no admitida para una approval de tipo ${approval.kind}.`);
      }
      const result = approval.kind === "permissions" ? decision : { decision };
      this.appServer.respond(approval.requestId, result);
      job.pendingApprovals.delete(idKey(requestId));
      if (job.status === "awaiting_approval" && job.pendingApprovals.size === 0) job.status = "running";
      this.touch(job);
      this.persist(job, true);
      return this.snapshot(job);
    });
  }

  get(jobId: string): JobSnapshot {
    return this.snapshot(this.getJob(jobId));
  }

  private async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureReady(): Promise<void> {
    await this.appServer.start();
    if (!this.rehydrated || this.recoveryFence) {
      await this.rehydrate();
      this.rehydrated = true;
    }
  }

  private async rehydrate(): Promise<void> {
    const candidates = [...this.jobs.values()].filter((job) => isActiveStatus(job.status) || job.status === "recovery_required");
    this.recoveryFence = candidates.length > 0;
    for (const job of candidates) {
      if (job.threadId === null) {
        this.setRecoveryRequired(job, new Error("thread/start incierto: no existe un thread_id confirmado; reconciliación automática deshabilitada."));
      } else {
        await this.reconcileJob(job, candidates.length === 1 && candidates[0]?.jobId === job.jobId);
      }
    }
    this.recoveryFence = [...this.jobs.values()].some((job) => job.status === "recovery_required");
  }

  private async reconcileJob(job: JobRecord, mayResume: boolean): Promise<void> {
    try {
      job.workspace = await validateWorkspace(job.workspace);
      const response = await this.appServer.request<unknown>("thread/read", { threadId: job.threadId, includeTurns: true });
      const thread = isObject(response) && isObject(response.thread) ? response.thread : null;
      if (!thread || stringValue(thread.id) !== job.threadId) throw new Error("thread/read devolvió un thread distinto.");
      const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObject) : [];
      const latest = turns.at(-1);
      if (latest) this.applyStoredTurn(job, latest);
      const latestStatus = stringValue(latest?.status);
      if (latestStatus === "inProgress") {
        if (!mayResume || this.activeJobId !== null && this.activeJobId !== job.jobId) {
          this.setRecoveryRequired(job, new Error("hay más de un turn activo persistido; la política V0.2 permite uno por proceso."));
          return;
        }
        const expectedTurnId = requiredString(latest?.id, "turn.id");
        const resumed = await this.appServer.request<unknown>("thread/resume", { threadId: job.threadId });
        const resumedThread = isObject(resumed) && isObject(resumed.thread) ? resumed.thread : null;
        if (!resumedThread || stringValue(resumedThread.id) !== job.threadId) throw new Error("thread/resume no confirmó el thread.");
        const resumedTurns = Array.isArray(resumedThread.turns) ? resumedThread.turns.filter(isObject) : [];
        const resumedTurn = resumedTurns.find((turn) => stringValue(turn.id) === expectedTurnId);
        if (!resumedTurn || stringValue(resumedTurn.status) !== "inProgress") throw new Error("thread/resume no confirmó el mismo turn inProgress.");
        if (isTerminal(job.status) || job.turnId !== expectedTurnId) return;
        job.status = "running";
        job.turnId = expectedTurnId;
        this.activeJobId = job.jobId;
      } else if (latest && latestStatus && isTerminal(latestStatus)) {
        this.applyTerminalStatus(job, latestStatus, latest);
      } else if (isActiveStatus(job.status) || job.status === "recovery_required") {
        this.setRecoveryRequired(job, new Error("thread/read no permitió determinar el estado final del turn."));
      }
      this.touch(job);
      this.persist(job);
    } catch (error) {
      this.setRecoveryRequired(job, error);
    }
  }

  private fromPersisted(value: PersistedJob): JobRecord {
    const status: JobStatus = ["starting", "running", "awaiting_approval", "interrupting", "completed", "interrupted", "failed", "recovery_required"].includes(value.status)
      ? value.status as JobStatus
      : "recovery_required";
    return {
      jobId: value.job_id, threadId: value.thread_id, workspace: value.workspace, turnId: value.turn_id, status,
      finalMessage: value.final_message, latestDiff: value.latest_diff, filesChanged: [...value.files_changed],
      commandsExecuted: [...value.commands_executed], error: value.error, pendingApprovals: new Map(),
      lastAgentMessage: value.final_message, agentMessages: new Map(), updatedAt: value.updated_at,
    };
  }

  private loadPersistedIndex(): void {
    for (const persisted of this.store.load()) {
      const job = this.fromPersisted(persisted);
      this.jobs.set(job.jobId, job);
      if (job.threadId !== null) this.jobsByThread.set(job.threadId, job.jobId);
    }
    if (this.store.getDiagnostic()) console.error(`[Codex Agent] ${this.store.getDiagnostic()}`);
  }

  private attachThread(job: JobRecord, threadId: string): void {
    if (job.threadId !== null && job.threadId !== threadId) this.jobsByThread.delete(job.threadId);
    const existing = this.jobsByThread.get(threadId);
    if (existing && existing !== job.jobId) throw new Error(`state ambiguo: thread_id ya pertenece a otro job (${threadId}).`);
    job.threadId = threadId;
    this.jobsByThread.set(threadId, job.jobId);
  }

  private async startTurn(job: JobRecord, prompt: string): Promise<void> {
    if (job.threadId === null) throw new Error("no hay thread confirmado para iniciar el turn.");
    this.resetTurn(job);
    const capture: TurnCapture = { jobId: job.jobId, threadId: job.threadId, turnId: null, buffered: [] };
    this.turnCaptures.set(job.threadId, capture);
    const params: TurnStartParams = {
      threadId: job.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(this.model ? { model: this.model } : {}),
      ...(this.reasoningEffort ? { effort: this.reasoningEffort as TurnStartParams["effort"] } : {}),
    };
    try {
      const response = await this.appServer.request<unknown>("turn/start", params);
      const turn = isObject(response) && isObject(response.turn) ? response.turn : null;
      const turnId = requiredString(turn?.id, "turn.id");
      capture.turnId = turnId;
      job.turnId = turnId;
      for (const message of capture.buffered) {
        const legacyApproval = message.method === "applyPatchApproval" || message.method === "execCommandApproval";
        if (legacyApproval || messageTurnId(message) === turnId) this.handleAppServerMessage(message);
      }
      capture.buffered = [];
      if (isTerminal(turn?.status)) {
        this.applyTerminalStatus(job, turn.status, turn);
      } else if (!isTerminal(job.status)) {
        job.status = job.pendingApprovals.size > 0 ? "awaiting_approval" : "running";
      }
      this.touch(job);
      this.persist(job, true);
    } finally {
      this.turnCaptures.delete(job.threadId);
    }
  }

  private resetTurn(job: JobRecord): void {
    job.turnId = null; job.status = "starting"; job.finalMessage = null; job.latestDiff = null;
    job.filesChanged = []; job.commandsExecuted = []; job.error = null; job.pendingApprovals.clear();
    job.lastAgentMessage = null; job.agentMessages.clear(); this.touch(job);
  }

  private handleAppServerMessage(message: AppServerMessage): void {
    const method = message.method;
    if (!method) return;
    const params = paramsForMessage(message);
    const legacy = method === "applyPatchApproval" || method === "execCommandApproval";
    const threadId = stringValue(legacy ? params?.conversationId : params?.threadId);
    const capture = threadId ? this.turnCaptures.get(threadId) : undefined;
    if (capture && capture.turnId === null && (isTurnScopedMethod(method) || method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval")) {
      capture.buffered.push(message);
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/permissions/requestApproval" || method === "applyPatchApproval" || method === "execCommandApproval") {
      this.handleApprovalRequest(message, method);
      return;
    }
    if (!params || !threadId) return;
    const job = this.jobForThread(threadId);
    if (!job || !this.matchesActiveTurn(job, message)) return;
    switch (method) {
      case "turn/started": {
        const turn = isObject(params.turn) ? params.turn : null;
        if (stringValue(turn?.id) === job.turnId) job.status = job.pendingApprovals.size > 0 ? "awaiting_approval" : "running";
        break;
      }
      case "turn/completed": {
        const turn = isObject(params.turn) ? params.turn : null;
        if (turn && isTerminal(turn.status) && stringValue(turn.id) === job.turnId) this.applyTerminalStatus(job, turn.status, turn);
        break;
      }
      case "turn/diff/updated":
        if (typeof params.diff === "string") job.latestDiff = params.diff;
        this.persist(job);
        break;
      case "item/agentMessage/delta": this.handleAgentMessageDelta(job, params); break;
      case "item/started":
      case "item/completed": this.handleItem(job, params); break;
      case "error":
        job.error = formatProtocolError(params.error ?? params.message);
        if (messageTurnId(message) === job.turnId) this.setRecoveryRequired(job, new Error(job.error));
        break;
      default: break;
    }
  }

  private matchesActiveTurn(job: JobRecord, message: AppServerMessage): boolean {
    const turnId = messageTurnId(message);
    return job.turnId !== null && turnId === job.turnId;
  }

  private handleApprovalRequest(
    message: AppServerMessage,
    method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval" | "applyPatchApproval" | "execCommandApproval",
  ): void {
    if (typeof message.id !== "number" && typeof message.id !== "string") return;
    const params = paramsForMessage(message);
    if (!params) {
      this.appServer.respondError(message.id, -32602, "Approval sin params válidos.");
      return;
    }
    const legacy = method === "applyPatchApproval" || method === "execCommandApproval";
    const threadId = stringValue(legacy ? params.conversationId : params.threadId);
    const job = threadId ? this.jobForThread(threadId) : null;
    const turnId = stringValue(legacy ? job?.turnId : params.turnId);
    const itemId = stringValue(legacy ? params.callId : params.itemId);
    if (!threadId || !job || !isActiveStatus(job.status) || !turnId || !itemId || job.turnId !== turnId) {
      this.appServer.respondError(message.id, -32001, "No existe un job/turn local para esta approval.");
      return;
    }
    const kind: ApprovalKind = method === "item/commandExecution/requestApproval" || method === "execCommandApproval"
      ? "command_execution"
      : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
        ? "file_change"
        : "permissions";
    job.pendingApprovals.set(idKey(message.id), { requestId: message.id, kind, method, threadId, turnId, itemId, params });
    job.status = "awaiting_approval";
    this.touch(job);
    this.persist(job);
  }

  private handleAgentMessageDelta(job: JobRecord, params: JsonObject): void {
    const itemId = stringValue(params.itemId); const delta = stringValue(params.delta);
    if (!itemId || delta === null) return;
    const current = job.agentMessages.get(itemId) ?? { text: "", phase: null };
    current.text += delta; job.agentMessages.set(itemId, current); job.lastAgentMessage = current.text;
  }

  private handleItem(job: JobRecord, params: JsonObject): void {
    const item = isObject(params.item) ? params.item : null;
    if (item) { this.recordItem(job, item); this.touch(job); this.persist(job); }
  }

  private applyStoredTurn(job: JobRecord, turn: JsonObject): void {
    const turnId = stringValue(turn.id);
    if (!turnId) return;
    job.turnId = turnId;
    this.recordTurnItems(job, turn);
  }

  private applyTerminalStatus(job: JobRecord, status: "completed" | "interrupted" | "failed", turn: JsonObject): void {
    this.recordTurnItems(job, turn);
    if (status === "completed") {
      job.status = "completed"; job.finalMessage = this.finalMessage(job); job.pendingApprovals.clear(); this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId;
    } else if (status === "interrupted") {
      job.status = "interrupted"; job.finalMessage = null; job.pendingApprovals.clear(); this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId;
    } else {
      job.status = "failed"; job.error = formatProtocolError(turn.error, "El turn falló."); job.pendingApprovals.clear(); this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId;
    }
    this.touch(job); this.persist(job);
  }

  private recordTurnItems(job: JobRecord, turn: JsonObject): void {
    if (Array.isArray(turn.items)) for (const item of turn.items) if (isObject(item)) this.recordItem(job, item);
  }

  private recordItem(job: JobRecord, item: JsonObject): void {
    if (item.type === "agentMessage") {
      const id = stringValue(item.id); const text = stringValue(item.text);
      if (!id || text === null) return;
      const phase = stringValue(item.phase); job.agentMessages.set(id, { text, phase }); job.lastAgentMessage = text;
      if (phase === "final_answer") job.finalMessage = text;
    } else if (item.type === "commandExecution") {
      const command = stringValue(item.command); const status = stringValue(item.status);
      if (command && (status === "completed" || status === "failed") && !job.commandsExecuted.includes(command)) job.commandsExecuted.push(command);
    } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
      for (const change of item.changes) if (isObject(change)) { const filePath = stringValue(change.path); if (filePath && !job.filesChanged.includes(filePath)) job.filesChanged.push(filePath); }
    }
  }

  private finalMessage(job: JobRecord): string | null {
    for (const message of job.agentMessages.values()) if (message.phase === "final_answer") return message.text;
    return job.finalMessage ?? job.lastAgentMessage;
  }

  private handleAppServerExit(error: Error): void {
    this.rehydrated = false;
    this.recoveryFence = true;
    this.activeJobId = null;
    for (const job of this.jobs.values()) {
      if (isActiveStatus(job.status)) this.setRecoveryRequired(job, error);
    }
  }

  private setFailure(job: JobRecord, error: unknown, uncertain: boolean): void {
    if (uncertain || error instanceof AppServerError && error.code === -32002) this.setRecoveryRequired(job, error);
    else { job.status = "failed"; job.error = error instanceof Error ? error.message : String(error); this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId; this.touch(job); this.persist(job); }
  }

  private setRecoveryRequired(job: JobRecord, error: unknown): void {
    this.rehydrated = false;
    this.recoveryFence = true;
    job.status = "recovery_required"; job.error = error instanceof Error ? error.message : String(error); job.pendingApprovals.clear(); this.activeJobId = this.activeJobId === job.jobId ? null : this.activeJobId; this.touch(job); this.persist(job);
  }

  private touch(job: JobRecord): void { job.updatedAt = new Date().toISOString(); }

  private persist(_job: JobRecord, required = false): boolean {
    const values: PersistedJob[] = [...this.jobs.values()].map((job) => ({
      job_id: job.jobId, thread_id: job.threadId, workspace: job.workspace, turn_id: job.turnId, status: job.status,
      final_message: job.finalMessage, latest_diff: job.latestDiff, files_changed: [...job.filesChanged], commands_executed: [...job.commandsExecuted], error: job.error, updated_at: job.updatedAt,
    }));
    try {
      this.store.save(values);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Codex Agent] persistencia local no disponible: ${message}`);
      for (const job of this.jobs.values()) {
        if (isActiveStatus(job.status)) {
          this.recoveryFence = true;
          job.status = "recovery_required";
          job.error = `No se pudo persistir el estado local: ${message}`;
          job.pendingApprovals.clear();
          if (this.activeJobId === job.jobId) this.activeJobId = null;
          this.touch(job);
        }
      }
      if (required) throw new Error(`No se pudo persistir el estado local: ${message}`);
      return false;
    }
  }

  private startResult(job: JobRecord): JobStartResult { return { job_id: job.jobId, thread_id: job.threadId, turn_id: job.turnId, status: job.status }; }
  private validatePrompt(prompt: string): void { if (typeof prompt !== "string" || prompt.trim().length === 0) throw new Error("prompt no puede estar vacío."); }
  private assertNoActiveTurn(): void {
    this.assertRecoveryFence();
    if (this.activeJobId !== null) throw new Error("backend ocupado: ya existe un turn activo; usa codex_get o codex_interrupt.");
  }
  private assertRecoveryFence(): void {
    if (this.recoveryFence) throw new Error("backend bloqueado: existe un job en recovery_required sin reconciliación concluyente; usa codex_get mientras se recupera el app-server.");
  }
  private jobForThread(threadId: string): JobRecord | null { const jobId = this.jobsByThread.get(threadId); return jobId ? this.jobs.get(jobId) ?? null : null; }
  private getJob(jobId: string): JobRecord { const job = this.jobs.get(jobId); if (!job) throw new Error(`job_id desconocido: ${jobId}`); return job; }

  private snapshot(job: JobRecord): JobSnapshot {
    const approvals = [...job.pendingApprovals.values()].map(approvalView);
    return { status: job.status, job_id: job.jobId, thread_id: job.threadId, turn_id: job.turnId, final_message: job.finalMessage, latest_diff: job.latestDiff, files_changed: [...job.filesChanged], commands_executed: [...job.commandsExecuted], error: job.error, pending_approval: approvals[0] ?? null, pending_approvals: approvals };
  }
}
