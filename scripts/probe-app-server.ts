import { CodexAppServer } from '../src/codex-app-server.js';
import { ModelCatalog } from '../src/model-routing.js';
const client = new CodexAppServer({ spawnOptions: { windowsHide: true }, rpcTimeoutMs: 30_000 });
await client.start();
try {
  const result=await new ModelCatalog(client,300000,Date.now,true).get();
  console.log(JSON.stringify({models:result.models,fetchedAt:result.fetchedAt,expiresAt:result.expiresAt,turnEffectiveConfirmation:'unavailable in Codex App Server 0.153.4 Turn response'},null,2));
} finally { await client.stop(); }
