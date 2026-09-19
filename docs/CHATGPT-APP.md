# AutoDev App 設定

0.4.2 採用 Cloudflare Workers Free 固定 HTTPS 入口。MCP URL 與 OAuth issuer 不隨內部 Quick Tunnel 重啟而改變；OpenAI Secure MCP Tunnel 保留為成本未確認的候選，沒有啟用 runtime key。選擇依據見 [成本政策](COST-POLICY.md)，實際驗收見 [固定入口驗收](FIXED-ENTRY-VALIDATION.md)。

| 欄位 | 設定 |
| --- | --- |
| App name | AutoDev |
| Description | 讓一般 ChatGPT 規劃與審查，由本機 Codex 執行已註冊專案，提供完整版本化證據與可接續的審查紀錄。 |
| Icon | [autodev-icon.png](../assets/autodev-icon.png)，PNG，256×256，2,755 bytes |
| Connection | 伺服器 URL |
| Server URL | 執行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\fixed-tunnel.ps1 connection-info`，使用顯示的固定 MCP URL |
| Authentication | OAuth |
| Client registration | 動態用戶端註冊（DCR） |
| Client ID / Secret | 不手填，由 DCR 完成；不要貼入本機 token 或路由 secret |
| Default scope | `autodev` |
| Base scopes | 留空 |
| Authorization / Token / Registration / Resource | 保留自動探索的同一固定 HTTPS origin；不要填 localhost 或內部 Quick URL |
| OIDC | 不啟用；本服務不是 OIDC provider |

首次在 ChatGPT「外掛程式」目錄按「建立應用程式」，填入上表。OAuth metadata 應探索到 `/oauth/authorize`、`/oauth/token`、`/oauth/register` 與 `/mcp`。建立後選「使用 AutoDev 登入」，核對授權頁上的應用程式、request ID 與 verification code，再於本機執行：

```powershell
.\scripts\fixed-tunnel.ps1 approve -RequestId '<授權頁 request ID>' -VerificationCode '<核對碼>'
```

連接完成後按「重新整理」掃描工具，應看到 9 個 AutoDev 工具。使用一般「對話」，選取 AutoDev 或明確要求使用 AutoDev；保留平台的逐次寫入確認。日常不需複製兩個模型之間的 prompt/result。

## 一次性遷移與重啟

本次 ChatGPT App UI 沒有修改既有 server URL 的控制項，因此將原工作中的 App 標記為「AutoDev（Quick 備援）」，新固定入口使用名稱 AutoDev。這是從隨機 URL 遷移的一次性設定；後續入口重啟沿用固定 App，不需再建立 App。

固定 gateway 以 Windows CurrentUser DPAPI 保存 DCR client、grant、token 雜湊與每筆授權的 refresh 簽章金鑰，綁定原使用者與相同 issuer。2026-09-12 起新授權沒有固定天數或一般 refresh 次數上限，持續有效直到撤銷；access token 仍只存活 10 分鐘並自動輪替。經驗證的 refresh 世代可辨識舊 token 重放並撤銷整組授權，無須永久累積已使用 token。持久資料維持 4 MiB 上限。舊 schema 1 授權保留原 8 小時／64 次限制，不延長或復活。撤銷、還原備份或平台要求重新連結時，使用同一 App 重新 OAuth；backup restore 會隔離舊 OAuth 狀態，避免恢復已撤銷 token。

OAuth grant 提供跨 HTTP request 的 reviewer identity；core 的 HMAC assertion、nonce 與同版 artifact 完整讀取收據仍有必要。Tunnel 身分不能代替 App/user 授權。某 grant 可由多個聊天共用，不能當作單一聊天已閱讀的密碼學證明；ChatGPT 真實審查須另外核對該聊天工具呼叫。

## 圖示

圖示以 code brackets 與雙向交接箭頭表達功能，無個人資料或 OpenAI／ChatGPT／Codex 官方 logo。SVG 原稿同目錄；`node scripts/build-icon.mjs` 可重建相同 PNG，無 API 或新增費用。

本次 Chrome 擴充功能拒絕自動上傳本機檔案（`Not allowed`），未擴大瀏覽器檔案權限。PNG 已在 repo 交付，可由使用者在 App 表單選取；此限制不影響 OAuth 與工具功能。


### 主動撤銷長期授權

在 `product/autodev` 先列出授權，再撤銷選定的 grant。只透過身分核對過的本機 admin 通道操作；不公開撤銷介面，也不輸出 token。

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/fixed-tunnel.ps1 -Action grants
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/fixed-tunnel.ps1 -Action revoke -GrantId "<選定的 grant_id>"
```

撤銷立即使該 grant 的 access 與 refresh token 全部失效，並跨重新啟動保留。ChatGPT 的「中斷連線」是否向本機撤銷授權由平台行為決定；需要確認本機授權已取消時，使用上述指令。永久授權不代表平台永不要求重新登入，也不代表電腦離線時仍能執行專案。
