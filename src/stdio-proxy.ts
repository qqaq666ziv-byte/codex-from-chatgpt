import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadLocalConfig, readLocalToken } from './local-config.js';

/** Official secure-tunnel child: exposes only the authenticated MCP tool surface, never admin. */
async function main() {
  const config=loadLocalConfig();
  const token=readLocalToken(config.runtimeDir,'client');
  const client=new Client({name:'autodev-secure-tunnel-proxy',version:'0.4.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const server=new Server({name:'AutoDev',version:'0.4.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>client.listTools());
  server.setRequestHandler(CallToolRequestSchema,async request=>client.callTool(request.params));
  const transport=new StdioServerTransport();
  transport.onclose=()=>void client.close();
  process.once('SIGINT',()=>void server.close().finally(()=>client.close()));
  process.once('SIGTERM',()=>void server.close().finally(()=>client.close()));
  await server.connect(transport);
}
void main().catch(()=>{console.error('AutoDev proxy could not connect. Run the local doctor; no credentials are written to stdout.');process.exitCode=1;});
