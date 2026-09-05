# AutoDev 開發者 App 設定

名稱、說明與圖示可直接採用。Tunnel 連線設定是待啟用候選，成本未確認前不要建立 key、連線或替換正在工作的 App。

| 欄位 | 設定 |
| --- | --- |
| App name | AutoDev |
| Description | 讓一般 ChatGPT 規劃與審查，由本機 Codex 執行已註冊專案，提供完整版本化證據與可接續的審查紀錄。 |
| Icon | [autodev-icon.png](../assets/autodev-icon.png)，PNG，256×256，2,755 bytes |
| Connection | Tunnel，選既有 **AutoDev** Secure MCP Tunnel，沿用原 ID |
| Authentication | OAuth；本版不使用 No authentication |
| OAuth Client ID / Client Secret | 留空，使用 discovery + Dynamic Client Registration；不貼本機 token 或 runtime key |
| Scope（若 UI 提供此欄） | `autodev` |
| Authorization / Token URL | 由 discovery 取得，不手填 localhost，不把 Tunnel control-plane URL 當 OAuth issuer |
| Server URL | Connection = Tunnel 時不需填新的 Quick Tunnel URL |

本機 gateway 的公開授權頁目前仍依賴 Quick Tunnel。上表省去 MCP Server URL 不代表授權流程已固定；**本版尚不能保證完整重啟後同 App 免重新連結**。

OAuth metadata 宣告 authorization_code、refresh_token、public client `none` 及 PKCE S256；`autodev` scope 會發行並輪替 refresh token。這不是 OIDC provider，不另要求 `openid`；目前沒有 `offline_access` scope，不能自行在 UI 加入不支援的 scope。grant 為 8 小時，gateway 重啟會失效；沒有把它包裝成持久 offline access。官方提醒需要 provider 正確提供 refresh 能力，永久登入不能由 refresh token 存在推論。[官方 refresh 說明](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

成本與固定授權入口解決後，最少人工步驟：在 ChatGPT 開啟 App 設定，選既有 AutoDev Tunnel + OAuth，完成平台要求的連線與本機對碼，Refresh 後在一般「對話」選取 AutoDev。其後交辦及審查都用工具往返，不需複製兩個模型之間的 prompt/result。詳細驗收流程見 [SECURE-TUNNEL.md](SECURE-TUNNEL.md)。

圖示以 code brackets 與雙向交接箭頭表達功能，無個人資料、無 OpenAI/ChatGPT/Codex 官方 logo。SVG 原稿同目錄；`node scripts/build-icon.mjs` 可重建相同 PNG，無 API／新增費用。
