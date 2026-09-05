# 零新增實際費用

2026-09-05，依使用者本輪明確修正。技術、API key、第三方服務、雲端、免費 credits 與免費 quota 都可以採用；不能僅因使用 API 或雲端就排除。判準是本帳號、本方案、本用途不會造成新增實際費用，以及安全、可靠性與日常體驗。

啟用前須同時成立：

1. 不需要新增付款方式。
2. 免費額度耗盡不會自動扣款。
3. 不會自動升級付費。
4. 額度耗盡時停止，沒有計費 fallback。
5. 不開啟 auto-recharge。
6. 不購買 credits 或付費方案。

不是要求供應商承諾永久免費。免費 credits 可以採用，但須知道適用服務、到期日及真正的停止機制。程式的共用成本契約接受 `free-service`、`free-tier`、`free-credits`，保存六項限制；credits 必須有有效期限。期限到達後拒絕啟動，正在運行的候選通道也會關閉。舊版僅有一個確認旗標的成本記錄須重新補齊證據，不能被默認當成符合新版條件。

## 本次選擇

| 方案 | 本次判斷 |
| --- | --- |
| Cloudflare Workers Free + Workers KV + 既有 cloudflared | 實際帳號 UI 已確認 Free／$0。使用免費 `workers.dev`，不買網域，不啟用 Paid、Containers、Workers AI、R2 或其他計費產品。Workers／KV 免費配額耗盡回錯誤；本服務停止，無付費 fallback。 |
| OpenAI Secure MCP Tunnel | runtime key 是 Tunnel 認證，不能等同模型 API 計費；但尚無足夠資料確認該 Tunnel 用途的適用費率、免費 credits 覆蓋及不產生超額費用。保留已完成的候選實作，未啟用 key。 |
| ngrok Free | 免費固定 domain 有技術可行性，但官方簽章 EXE 被此 Windows 的 Application Control 封鎖。沒有繞過政策；不保留未能執行的產品 transport。 |
| 既有 ChatGPT／Codex 登入 | 沿用已驗證的 `gpt-6-astra`／`xhigh`。這是本次可靠且無新增模型費用的工程選擇，並非宣稱所有 API 方案都被禁止。 |

Cloudflare Free 的限制包括 Workers 每日 100,000 requests、每次 10 ms CPU，以及 KV 每日 100,000 reads、1,000 writes/deletes/lists。單一路由每 20 分鐘續租約 72 writes/day；公開請求仍會消耗共用免費額度。負載、濫用或帳號其他專案可能耗盡配額，結果是服務不可用，不能自動升級。[Workers 價格](https://developers.cloudflare.com/workers/platform/pricing/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[KV 價格](https://developers.cloudflare.com/kv/platform/pricing/)

OpenAI 預付／免費 credits 並不自行證明硬停止：官方說明預付扣停可能有延遲，支出硬上限也可能略有超支；尚未確認這些機制是否涵蓋 Secure Tunnel。不能用「沒有付款方式」或「餘額為零」代替用途與帳務證據。[預付帳務](https://help.openai.com/en/articles/8264644-what-is-prepaid-billing)、[支出限制](https://developers.openai.com/api/docs/guides/spend-limits)、[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

部署工具只要求 Cloudflare account/user read、Workers scripts/routes write 及 KV write，不要求帳務寫入、計費產品或模型 API 權限。登入資料留在工作區私人 CLI 目錄；runtime 使用自己的 DPAPI 路由密鑰。無自動購買、充值或升級程式。

如果使用者日後手動變更帳號方案，須在重新啟用前重查成本證據。對無法確認零費用的新方案，先完成獨立工程，直到真正啟用前才提出具體阻礙。
