# AutoDev 免費固定入口

固定 `workers.dev` HTTPS 入口只處理現有 gateway 的 OAuth discovery、授權與 MCP。它從 `ROUTES` KV 取得短期路由，把 HTTP 內容用每次本機啟動新產生的 AES-256-GCM key 加密，再送到本機擁有的 Cloudflare Quick Tunnel。它不提供任意 URL proxy、遠端管理或 plaintext fallback。

## 部署契約

- Module entry：`worker.mjs`；僅使用標準 Fetch、Streams、WebCrypto，不需要 Node compatibility flag。
- `ROUTES`：專用 KV namespace binding；只有 `active-route` 這一個 key。
- `ROUTE_SECRET`：Cloudflare secret binding，43–128 字元 base64url 隨機秘密；不寫入一般 vars、Git 或 log。它只授權 route registration。
- 帳號保持 **Workers Free**。Wrangler 配置由主實作管理，停用 observability、preview URLs 與額外付費產品；Worker 不含費用方案切換、付款、auto-recharge 或購買程式。
- 只應有一個本機 runner 更新路由。每次 runner 產生新的 32-byte `relayKey`，每 20 分鐘續租 60 分鐘；正常一天約 72 次寫入。重啟與手動重試另計，不能無限快速重試。

`PUT /_autodev/route` 必須使用 `Authorization: Bearer <ROUTE_SECRET>` 與 `Content-Type: application/json`。body 上限 2 KiB，且只有三個欄位：

```json
{
  "origin": "https://assigned-quick-name.trycloudflare.com",
  "expiresAt": "2026-09-05T01:00:00.000Z",
  "relayKey": "<canonical base64url encoding of 32 random bytes>"
}
```

上例時間只是格式示範。期限必須距 Worker 現在 20–60 分鐘，且是 `Date.toISOString()` 格式。origin 必須是小寫、單層 `*.trycloudflare.com` HTTPS origin，不接受帳密、port、尾端斜線、path、query 或 hash。寫入等待 KV 完成，TTL 為期限剩餘秒數向下取整。成功回 `200 {"ok":true,"expiresAt":"..."}`，不回傳 origin 或 key。無效 secret 回 401；無效內容回 400/413；KV 失敗回安全 503。

`GET /_autodev/health` 回 `200 {"ok":true,"routeReady":true|false}`；沒有路由或過期時是 false，KV 錯誤是 503。這只證明 Worker/KV 租約狀態，**不代表 gateway 已連通**。runner 必須另外讀固定入口的 discovery，核對經解密驗證的 `X-AutoDev-Instance` 等於本次程序 UUID。

## 公開路徑

| Method | Path | Query |
| --- | --- | --- |
| GET | `/.well-known/oauth-protected-resource` | 禁止 |
| GET | `/.well-known/oauth-protected-resource/mcp` | 禁止 |
| GET | `/.well-known/oauth-authorization-server` | 禁止 |
| POST | `/oauth/register` | 禁止 |
| POST | `/oauth/token` | 禁止 |
| GET | `/oauth/authorize` | 交本機 OAuth 驗證 |
| GET | `/oauth/result` | 交本機 OAuth 驗證 |
| POST | `/mcp` | 禁止 |

其他 path 是 404，已知 path 的其他 method 是 405；沒有 SSE、WebSocket、OPTIONS/CORS 或管理端點。POST payload 與 decoded response body 各上限 2 MiB，URL 上限 8 KiB，轉送 header 上限 16 KiB。輸入禁止 Content-Encoding 和 Upgrade。

Worker 重新建立 header allowlist。只有 `accept`、`content-type`，以及 `/mcp` 的 `authorization`、`mcp-protocol-version`、`mcp-session-id`；`/oauth/token` 也可保留 Authorization。Cookie、Host、forwarded headers、內部 assertion、Cloudflare credentials 與其他 header 都不轉送。OAuth access token 和原始 body 只存在加密 envelope 內。

## 加密協定

route 的 `relayKey` 是 AES-256-GCM key。outer JSON 僅含 `{v:1,id,iv,data}`；`id` 為每次新產生的 16 bytes，IV 為 12 bytes，data 為 ciphertext 加 16-byte authentication tag，全部使用 canonical 無 padding base64url。

request AAD 是 UTF-8 `AutoDev relay v1\nrequest\n<public issuer origin>\n<id>`，明文：

```text
{method, path, headers: [[name,value],...], body: base64url, issuedAt: epochMilliseconds}
```

Worker 只向 `origin + '/_autodev/relay'` POST JSON，`redirect: 'manual'`，外層不帶任何使用者憑證。gateway 驗證時間與重播，完成內層 OAuth/MCP 後回 outer 200 JSON。response AAD 把方向改為 `response`，id 保持相同、IV 必須更新；明文：

```text
{status, headers: [[name,value],...], body: base64url}
```

plaintext JSON 上限 3 MiB，outer wire 上限 4 MiB。兩層 base64 會讓 2 MiB 原始 body 變成約 3.73 MiB wire，因此 outer 不能限制為 3 MiB。Worker 先完整驗證、解密並檢查所有上限，再產生公開 response；這個有界 buffer 可避免收到一半才發現偽造、超限或失效。65 秒 deadline、請求取消、KV/fetch/crypto 錯誤均停止處理；錯誤不附帶原始 exception 或上游 response。

僅允許 JSON，以及 OAuth authorize/result 的本機 HTML。302 只允許 `/oauth/result` 回到本機 OAuth 原本允許的 exact `https://chatgpt.com/connector_platform_oauth_redirect` 或 `/connector/oauth/<bounded-id>`，query 必須恰好包含 `state`、本入口 `iss` 和 `code` 或 `error=access_denied`。不跟隨 redirect、不保留 Set-Cookie、外部 Refresh、上游身分或 arbitrary Location。metadata 才能回本機 UUID `X-AutoDev-Instance`。所有公開 response 禁止快取；HTML 套用嚴格 CSP。內層 429/5xx 收斂為安全 503。

## 免費額度與限制

2026-09-05 查核：Workers Free 每日 100,000 requests、每次 10 ms CPU；KV Free 每日 100,000 reads、1,000 writes，超額後該操作失敗，UTC 00:00 重設。沒有額外費用 fallback。平台在 Worker 執行前因配額/CPU 限制拒絕時，平台錯誤頁不由此程式控制；同樣不得因此升級付費。加密與大 payload 的 CPU 負擔須用實際免費帳號驗證，通過 Node 測試不代表 Cloudflare Free 10 ms 保證。

每個公開轉送及 health 讀一次 KV。未授權 route PUT 和未允許路徑不讀寫 KV。官方 KV 每 key 每秒最多一次寫入，`cacheTtl` 最小 30 秒、寫入 TTL 最少 60 秒；本實作使用 30 秒讀取 cacheTtl。KV 是 eventual consistency，舊地區讀值可能維持約 60 秒或先前 cacheTtl，新路由不是立即全球生效。舊租約不會當成新的 readiness 證據；每次啟動換 AES key 可防止 Quick hostname 被重新指派時讀取旧路由的 bearer 外洩，並使無法驗證的回應停止。租約到期在讀取、dispatch 前及回應解密後都檢查。

這不取代本機所有權檢查、程序監督、持續啟用電腦/網路與 OAuth 自身驗證。KV 保存短期 relay key，Cloudflare 是信任邊界內的服務；不得把 KV dump 或請求記錄放進交付報告。

官方查核來源：

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [KV pricing and Free over-quota failure](https://developers.cloudflare.com/kv/platform/pricing/)
- [KV limits](https://developers.cloudflare.com/kv/platform/limits/)
- [KV write TTL and consistency](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)
- [KV read options](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)
- [Workers WebCrypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

## 本機驗證

從 product/autodev 執行 `node --test edge/test/worker.test.mjs`。測試使用 Node 內建 Request/Response、fake KV/fetch 與獨立 Node AES-GCM 實作，沒有外部網路、帳號、secret 或依賴下載。涵蓋 lease、header/path 白名單、加密互通、大小/期限、redirect、空 204、quota/fetch 失敗與串流取消。Wrangler dry-run 與實際帳號遠端探測由主實作另外記錄，不能用這些 unit tests 代替。
