import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { OAuthGate, OAuthError } from './oauth.js';
import { authorized } from './local-config.js';

type Options={issuer:string;publicPort:number;controlPort:number;upstream:string;clientToken:string;adminToken:string;instance?:string;onShutdown?:()=>void};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
async function body(req:IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>2*1024*1024)throw new Error('Request too large.');chunks.push(b);}return Buffer.concat(chunks).toString('utf8');}
function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}

/** A development ingress: OAuth on the public port, administration only on a separate loopback port. */
export async function createGateway(options:Options) {
  const issuer=new URL(options.issuer);
  if(issuer.protocol!=='https:'||issuer.origin!==options.issuer||issuer.username||issuer.password)throw new Error('Use an exact HTTPS origin.');
  const upstream=new URL(options.upstream);
  if(upstream.protocol!=='http:'||upstream.hostname!=='127.0.0.1'||upstream.pathname!=='/mcp')throw new Error('Upstream must be the local AutoDev MCP endpoint.');
  const gate=new OAuthGate({issuer:options.issuer});
  const sessions=new Map<string,string>();
  const publicServer=createServer(async(req,res)=>{
    try {
      if(req.headers.host!==issuer.host&&req.headers.host!==`127.0.0.1:${options.publicPort}`){json(res,403,{error:'invalid_host'});return;}
      const url=new URL(req.url??'/',issuer);
      if(req.method==='GET'&&(url.pathname==='/.well-known/oauth-protected-resource'||url.pathname==='/.well-known/oauth-protected-resource/mcp')){json(res,200,gate.resourceMetadata());return;}
      if(req.method==='GET'&&url.pathname==='/.well-known/oauth-authorization-server'){json(res,200,gate.metadata());return;}
      if(req.method==='POST'&&url.pathname==='/oauth/register'){json(res,201,gate.register(JSON.parse(await body(req))));return;}
      if(req.method==='POST'&&url.pathname==='/oauth/token'){json(res,200,gate.token(new URLSearchParams(await body(req))));return;}
      if(req.method==='GET'&&url.pathname==='/oauth/authorize'){
        const pending=gate.begin(url.searchParams);
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'"});
        res.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="3;url=/oauth/result?request_id=${encodeURIComponent(pending.request_id)}"><title>AutoDev 連線核准</title><style>body{font:18px system-ui;max-width:640px;margin:12vh auto;padding:24px;line-height:1.7;background:#f5f5f3;color:#202624}code{word-break:break-all}</style><h1>確認連接 AutoDev</h1><p>請在執行 AutoDev 的電腦核對下列代碼，並使用本機連線管理指令批准。這會允許此連線交辦、查看證據及記錄審查；Codex 提權仍需另外核准。</p><p>應用程式：${escape(pending.client_name)}</p><p>核對碼：<strong>${escape(pending.verification_code)}</strong></p><p>請求：<code>${escape(pending.request_id)}</code></p><p>此頁會自動等待核准。不需要 OpenAI API Key，也不收取 API 模型費用。</p></html>`);return;
      }
      if(req.method==='GET'&&url.pathname==='/oauth/result'){
        const id=url.searchParams.get('request_id')??'';const result=gate.finish(id);
        if(result.status==='pending'){
          const pending=gate.pendingRequests().find(p=>p.request_id===id);
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});
          res.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="3"><title>等待 AutoDev 核准</title><h1>等待本機核准</h1><p>應用程式：${escape(pending?.client_name??'')}</p><p>核對碼：<strong>${escape(pending?.verification_code??'')}</strong></p><p>請求：<code>${escape(id)}</code></p><p>請在本機使用 connect-chatgpt.ps1 status 核對，再執行 approve。此頁會自動接續。</p></html>`);
        }else{res.writeHead(302,{Location:result.redirect_url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();}return;
      }
      if(url.pathname!=='/mcp'||url.search){json(res,404,{error:'not_found'});return;}
      if(req.method==='GET'){json(res,405,{error:'SSE is unavailable; use JSON POST.'});return;}
      if(req.method!=='POST'&&req.method!=='DELETE'){json(res,405,{error:'method_not_allowed'});return;}
      const header=req.headers.authorization;
      if(!header?.startsWith('Bearer ')){res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${options.issuer}/.well-known/oauth-protected-resource/mcp"`);json(res,401,{error:'invalid_token'});return;}
      let grant;
      try{grant=gate.verify(header.slice(7));}catch{res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${options.issuer}/.well-known/oauth-protected-resource/mcp"`);json(res,401,{error:'invalid_token'});return;}
      const sid=req.headers['mcp-session-id'];
      if(sid&&(typeof sid!=='string'||sessions.get(sid)!==grant.grant_id)){json(res,404,{error:'unknown_session'});return;}
      if(!sid&&sessions.size>=32){json(res,429,{error:'session_capacity'});return;}
      const headers:Record<string,string>={Authorization:`Bearer ${options.clientToken}`,Accept:'application/json, text/event-stream','Content-Type':'application/json'};
      if(typeof sid==='string')headers['mcp-session-id']=sid;
      if(typeof req.headers['mcp-protocol-version']==='string')headers['mcp-protocol-version']=req.headers['mcp-protocol-version'];
      const response=await fetch(upstream,{method:req.method,headers,...(req.method==='POST'?{body:await body(req)}:{}),signal:AbortSignal.timeout(60_000),redirect:'error'});
      const responseId=response.headers.get('mcp-session-id');
      if(responseId){const owner=sessions.get(responseId);if(owner&&owner!==grant.grant_id)throw new Error('Session ownership changed.');sessions.set(responseId,grant.grant_id);res.setHeader('mcp-session-id',responseId);}
      if(req.method==='DELETE'&&response.ok&&typeof sid==='string')sessions.delete(sid);
      if((response.headers.get('content-type')??'').includes('text/event-stream'))throw new Error('SSE response is unsupported.');
      res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json','Cache-Control':'no-store'});res.end(await response.text());
    }catch(error){if(!res.headersSent)json(res,error instanceof OAuthError?error.status:400,{error:error instanceof OAuthError?error.code:'request_rejected'});else res.end();}
  });
  const controlServer=createServer(async(req,res)=>{
    try {
      if(req.headers.host!==`127.0.0.1:${options.controlPort}`||req.headers.origin){json(res,403,{error:'invalid_origin'});return;}
      if(!authorized(req.headers.authorization,options.adminToken)){json(res,401,{error:'authentication_required'});return;}
      if(req.url==='/status'&&req.method==='GET'){json(res,200,{process_id:process.pid,instance_id:options.instance??'test',issuer:options.issuer,pending:gate.pendingRequests()});return;}
      if(req.url==='/approve'&&req.method==='POST'){
        const p=JSON.parse(await body(req)) as Record<string,unknown>;
        if(typeof p.request_id!=='string'||typeof p.verification_code!=='string'||typeof p.approve!=='boolean')throw new Error('Invalid approval.');
        json(res,200,gate.localApproval(p.request_id,p.approve,p.verification_code));return;
      }
      if(req.url==='/shutdown'&&req.method==='POST'){json(res,200,{stopping:true});setImmediate(()=>options.onShutdown?.());return;}
      json(res,404,{error:'not_found'});
    }catch{json(res,400,{error:'request_rejected'});}
  });
  publicServer.requestTimeout=65_000;controlServer.requestTimeout=10_000;
  const close=async()=>{for(const server of[publicServer,controlServer]){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
  try{
    for(const[server,port]of[[controlServer,options.controlPort],[publicServer,options.publicPort]]as const)await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  }catch(error){await close();throw error;}
  return {close};
}
