# Secure Tunnel 交付與驗證 — 2026-09-05

AutoDev **0.4.1**；repository `qqaq666ziv-byte/codex-from-chatgpt`，branch `codex/autodev-product`。延續已驗收 `cc18c408f1431336f4ba673c4d26c81b68aa4f91`，沒有重寫基準。此報告對應新增 Secure Tunnel 候選與 Windows 備份／恢復交付；舊版真實 ChatGPT 證據見 [原驗收紀錄](VALIDATION-2026-09-05.md)。

**結論：可離線交付的工程已完成；固定日常入口尚未啟用，也未通過新版一般 ChatGPT E2E。**

## 當日實際執行

- 本機環境：Windows、Node 24.16.0、npm 11.13.0、Codex CLI 0.153.3；Windows PowerShell 5.1.26100.9278 與 PowerShell 7.6.5。沒有安裝／升級 npm dependency，lockfile 只更新產品版本。
- `secure-tunnel.ps1 setup`：已安裝的官方 client **v0.0.14** archive 與 exe hash 均核對通過；來源、雜湊與授權見 [SOURCE](SOURCE.md)。沒有全域安裝。
- `secure-tunnel.ps1 configure`：沿用使用者既有 AutoDev Tunnel ID，僅保存 ignored 本機設定；沒有建立新 Tunnel，私人 ID 不入 Git。
- `secure-tunnel.ps1 doctor`：binary verified、configured、`cost_status=unverified`、`credential_present=false`、`fixed_entry_ready=false`。這個 doctor 不呼叫官方 control plane。
- 實際有效的既有 AutoDev connector 唯讀 `autodev_projects`／`autodev_status`：registry 仍只含 acceptance，原 median job 仍 completed／review pass，原 manifest 相同；另一個既有 job 仍 pending review。這是 **Codex 中對既有 Quick Tunnel 的查核**，不是一般 ChatGPT 的新固定入口 E2E。
- 最終 `npm.cmd run check` **exit 0**：typecheck、**192 total／190 passed／0 failed／2 skipped**、build 通過；測試約 266 秒。兩項 skip 分別是 opt-in 真實 App Server handshake／thread-list 與非 Windows stale-file lock；官方 native、PS 5.1／7 及 Windows Job 測試均實際執行。
- `git diff --check` 通過；25 個修改產品文件的本地連結無缺檔，PNG 尺寸／大小通過；待提交檔案未含私人 Tunnel ID，runtime／backups／tools／local-tests 沒有 Git 追蹤。外層交接文件另有 26 個本地連結通過，歷史 current-plan／fixture 沒有變更。

## 測試覆蓋與實際限制

| 驗證 | 執行方式／結果的涵義 |
| --- | --- |
| 官方 native transport | 真的執行 hash-verified Windows `tunnel-client.exe`，連到隔離 loopback synthetic control plane／真實 OAuth gateway／真實 AutoDev MCP handler；模型 executor 是 synthetic，不呼叫任何模型或官方 control plane。6 項含子案例通過。 |
| 官方協定／readiness | 驗證真實 poll path、runtime auth、client version、JSON-RPC ID、shard correlation、成功 poll metric，以及純文字 healthz／readyz；full load 曾抓到 poll 先於 readyz 的測試競態，改為分開等待真正 HTTP 200，沒有放寬最後斷言。 |
| 負面與 recovery | 401／OAuth challenge、偽造 identity/header、不完整 evidence 禁止 review、跨 grant 收據隔離、poll 503／socket disconnect 恢復、response retry 不再次執行 MCP、同 Tunnel ID 的 native restart。既有 core 回歸另涵蓋 duplicate request、未註冊專案、stale identity、journal uncertain 不重送、persisted review。 |
| Windows Job Object | 5 項實際 Windows 程序測試：參數／中文／環境隔離、正常 stop、native 提早退出與啟動失敗、helper／supervisor 異常終止、descendant 一併終止。使用 Windows 10+ 原子 job assignment，credential 不進 helper argv／env／生成程式碼。 |
| Windows launcher | PS 5.1／7 實際啟動腳本，驗證本機 configure、保留既有 Tunnel identity、零費用未確認前 start/run/credential 全拒絕，沒有 key／process record；writer mutex 阻擋並行 configure／credential。 |
| Windows backup／update／restore | PS 5.1／7 實際合成 runtime：checksum／ACL、完整 runtime 與 evidence 保留、volatile 排除、活動程序／writer／job／pending dispatch 阻擋、corrupt schema 拒絕、path traversal／junction 拒絕、build 失敗後 start 拒絕、restore 前保留原 runtime。沒有對目前真實 runtime 執行 update 或 restore。 |
| 獨立程式審查 | 修正 supervisor crash 留下 native child、configure/start 成本競態、重複 start 被 assertStopped 阻擋、gateway 死亡仍顯示可驗收，以及啟動取消可能殘留 control listener。這項整合審查不等於完整真實 Secure Tunnel runner E2E。 |

測試使用本工作區內可拋棄的合成資料、臨時連接埠及假 credential；官方原生測試以 loopback proxy 拒絕外部目的地。沒有新遠端資源、模型 API 呼叫、私人 runtime log 或 credential 上傳。未停止既有 Quick gateway、core 或 PoC watcher。

## 模型與 evidence 身分

使用者本輪指定 **GPT-6 Astra／xhigh**；AutoDev 目前唯讀工具回應的 `requested_model=gpt-6-astra`、`requested_effort=xhigh` 已確認。既有真實 median 任務的有效模型／effort 是已驗收基準證據，保留原紀錄；本輪沒有透過固定 Tunnel 執行新的真實 Codex turn，因此不虛構新的 effective model 值。本機 transport fixture 明確使用 synthetic executor，不能當模型驗證。目前 Codex host 工具沒有回傳此建置回合可獨立核對的 effective model／effort，不把產品設定當成本建置回合的執行證明。

OAuth 繼續保留：官方 noauth 是匿名、Tunnel identity 代表連線、協定未給穩定且可信的 end-user subject。真實 native forwarding 測試證明自稱 headers 不能取得別人的 proof；HMAC assertion、nonce 與 grant identity 仍有效。OAuth refresh 可在同 grant 下輪替 token，跨一般聊天可能共用 grant；它不是特定 ChatGPT 對話或模型的密碼學身分。gateway 完整重啟會撤銷 DCR／grants，舊 receipt 不可移交新 grant；持久 review 本身仍保存在 core。

## 完成狀態

| 類別 | 狀態 |
| --- | --- |
| 已實作且本機驗證 | pinned native install／hash、成本 gate、DPAPI 本機 credential 介面、受控 start/status/stop、native reconnect、Windows job cleanup、backup/update/restore、圖示與 App metadata。credential 真實儲存及完整 candidate launch 尚未使用正式 key。 |
| 已實作但未經真實平台驗證 | Secure Tunnel candidate 管理程式接上既有 OAuth HTTP 路徑；需官方零費用證據後才能正式連線驗證。 |
| 尚未完成 | 固定 OAuth browser issuer 與 restart persistence；固定 Tunnel 設為 default；同一 ChatGPT App 的重啟恢復；固定入口讀回舊 evidence/review；一般 ChatGPT 新代表性任務與 review。 |
| 尚未驗證 | Windows 整機 reboot、睡眠恢復、登入後常駐；沒有設定排程／Service／Startup，不能聲稱自動恢復。 |
| 平台目前限制 | 官方 MCP 文件仍為 web only，沒有 iOS 私人 developer App 驗收；不以手機內建 App 能力推論 MCP 可用。[官方說明](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) |
| 未有已驗證的平台機制 | 回合結束後自動喚醒原一般 ChatGPT 對話；未以背景 API 模型冒充，仍保存待審狀態供下次接續。這不等於已證明所有未來平台機制都不可能。 |

## 零新增費用與最後解除條件

**新版整條 Secure Tunnel 路徑的零新增費用：未確認。** [官方指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)、[官方價格](https://developers.openai.com/api/docs/pricing) 與當日可見帳號費用資訊沒有提供本帳號／用法的明確零費用結論。runtime key 是 Tunnel 認證 credential，不能自動當作模型用量費，也不能因未列價就推定 Tunnel 免費。

下一步需要 OpenAI 官方確認此帳號、既有 AutoDev Secure Tunnel、runtime Read + Use 及實際連線／轉送流量不會增加費用。確認前不建立／使用 runtime key，不要求在聊天貼 key，也不接受「同意未知費用」代替零費用要求。

即使成本解決，仍須決定並實作零新增費用的固定 OAuth browser endpoint／重啟持久化，或取得並實測官方等效 trusted identity。因為 [官方說明](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/connectors.md#oauth-protected-connector-behavior) 指出瀏覽器 OAuth 不經 Tunnel，僅更換 MCP 連線不會完成免重掛的日常體驗。

目前已工作的 Quick Tunnel＋OAuth 是保留的零新增費用替代路徑；它有隨機 URL／重新授權限制，**不等同固定日常入口**。沒有採用需要新付費方案、購買網域或模型 API 的替代方案，也沒有聲稱找到已驗收且同等體驗的免費固定替代服務。

成本及固定認證成立後，最少人工設定及一般 ChatGPT 新任務驗收步驟已備於 [CHATGPT-APP](CHATGPT-APP.md)／[SECURE-TUNNEL](SECURE-TUNNEL.md)。不用使用者在模型間搬運結果。

## 交付與 rollback

- [架構／安裝／啟停／診斷／更新／恢復](SECURE-TUNNEL.md)
- [ChatGPT App 精確設定](CHATGPT-APP.md)
- [PNG 圖示](../assets/autodev-icon.png)：256×256、2,755 bytes；[SVG](../assets/autodev-icon.svg) 原稿與本機重建腳本均已交付。
- 使用既有 `codex/autodev-product` 分支交付，最終 commit 見 Git 歷史及本輪交付回覆；無 merge／deploy／remote 修改。
- rollback 詳見操作文件：本版先做已驗證 offline backup 並停止服務，保留當前 runtime，選回 `cc18c40` 或相容版本重建。restore 只處理 runtime，不回復程式 checkout 或其他外部副作用，不用 `reset --hard`。
