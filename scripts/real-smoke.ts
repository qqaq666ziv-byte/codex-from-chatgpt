import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexAppServer } from '../src/codex-app-server.js';

const root = path.resolve('.local-tests');
mkdirSync(root, { recursive: true });
const workspace = mkdtempSync(path.join(root, 'real-codex-'));
writeFileSync(path.join(workspace, 'AGENTS.md'), 'Work only in this isolated fixture. Do not read credentials, .env, other repositories or home files. No dependencies, network, git commits, push or deployment. Run node --test.\n');
writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test' } }));
execFileSync('git', ['init', '-q'], { cwd: workspace, windowsHide: true });
const client = new CodexAppServer({ spawnOptions: { windowsHide: true }, rpcTimeoutMs: 60000 });
let threadId = ''; let turnId = ''; let terminal: unknown; const items: unknown[] = []; const diffs: string[] = [];
client.addMessageListener(message => {
  const params = message.params as Record<string, any> | undefined;
  if (!params || params.threadId !== threadId) return;
  if (message.id !== undefined) console.log(JSON.stringify({ pending_request: message.method, request_id: message.id, params }));
  if (message.method === 'item/completed') items.push(params.item);
  if (message.method === 'turn/diff/updated') diffs.push(params.diff);
  if (message.method === 'turn/completed') terminal = params.turn;
});
try {
  await client.start();
  const response = await client.request<Record<string, any>>('thread/start', {
    cwd: workspace, model: 'gpt-6-astra', config: { model_reasoning_effort: 'xhigh' },
    sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user',
  });
  threadId = response.thread.id;
  const effective = { model: response.model, reasoningEffort: response.reasoningEffort, approvalPolicy: response.approvalPolicy, sandbox: response.sandbox };
  console.log(JSON.stringify({ workspace, threadId, effective }));
  if (response.model !== 'gpt-6-astra' || response.reasoningEffort !== 'xhigh') throw new Error('Unexpected effective model/effort; no silent fallback.');
  const started = await client.request<Record<string, any>>('turn/start', { threadId, model: 'gpt-6-astra', effort: 'xhigh', input: [{type:'text',text:'Implement a new sum(values) function in sum.js. It returns the sum of an array of finite numbers; empty array returns 0; reject non-array, NaN, infinity and non-number entries with TypeError. Add sum.test.js using node:test for these requirements, run node --test and report actual result. Modify only this isolated project. Do not commit or install anything.',text_elements:[]}] });
  turnId = started.turn.id;
  const deadline = Date.now() + 15 * 60_000;
  while (!terminal && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
  if (!terminal) { await client.request('turn/interrupt', {threadId,turnId}); throw new Error('Smoke timeout; turn interrupt requested.'); }
  const independent = execFileSync(process.execPath, ['--test'], { cwd: workspace, encoding:'utf8', windowsHide:true });
  const result = { workspace, threadId, turnId, effective, terminal, items, diffs, independent_test_output: independent, review_status: 'pending_chatgpt_review' };
  writeFileSync(path.join(workspace,'acceptance.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({workspace,threadId,turnId,terminal,independent_test_output:independent,review_status:'pending_chatgpt_review'}));
} finally { await client.stop(); }
