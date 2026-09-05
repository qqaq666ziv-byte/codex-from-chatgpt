import { CodexAppServer } from '../src/codex-app-server.js';
const client = new CodexAppServer({ spawnOptions: { windowsHide: true }, rpcTimeoutMs: 30_000 });
await client.start();
try {
  const result = await client.request<{data: Array<Record<string, unknown>>;nextCursor?: string|null}>('model/list', {limit: 100, includeHidden: false});
  console.log(JSON.stringify({models:result.data.map(m=>({id:m.id,model:m.model,isDefault:m.isDefault,defaultReasoningEffort:m.defaultReasoningEffort,supportedReasoningEfforts:m.supportedReasoningEfforts})),nextCursor:result.nextCursor},null,2));
} finally { await client.stop(); }
