# 2026-09-05 驗收紀錄

版本：AutoDev 0.4.0 開發分支。本紀錄以所在 Git commit 為準，未宣告整個產品完成。

## 本機工程驗證

- `npm.cmd run check`：exit 0。TypeScript typecheck、154 項測試（152 passed、0 failed、2 skipped）、production build 通過。
- 兩项略過為預設不執行的真實 App Server 選用測試，以及目前 Windows 環境不適用的非 Windows 檔案鎖測試。選用 App Server 握手／thread list 曾以明確開關另外執行，1/1 通過；它不是實際交辦或 ChatGPT 審查。
- Windows PowerShell 5.1 與 PowerShell 7 均實測 ACL、原生命令引數、中文路徑、重複註冊、程序身分、啟停、occupied port、readiness 失敗及核准回覆。PS 5.1 行為測試只使用測試子程序的暫時執行政策，不變更系統政策。
- 涵蓋 request journal 的程序中斷／不重複派送、不可變證據與 UTF-8 分頁、資料破損拒絕、來源變更與遲到事件使審查失效、原 turn 恢復、模型／effort 不符拒絕、問題及權限核准往返。
- OAuth 與 gateway 合成整合測試 17/17 通過：DCR／S256、精確 callback／client／resource 綁定、本機核對碼、code 重播、refresh 輪替／撤銷、8 小時 grant 期限、跨 grant session 隔離、公開與管理埠隔離、JSON MCP／GET 405。DCR client 的租期修正後也獨立重跑同組 17 項及 build 通過。
- `node --import tsx scripts/verify-local-mcp.ts`：對實際已啟動的服務確認 HTTP 401、Host／Origin 403、client 無法呼叫 admin、stdio 九工具及真實 readonly calls。沒有執行寫入或冒充 ChatGPT。
- Plugin／Skill 官方 validator 通過，未假定可攜技能本身會建立 MCP 連線。

## 真實 Codex 執行

官方 Codex CLI 0.153.3；`codex login status` 確認使用 ChatGPT 登入。App Server `model/list`、`thread/start` 與後續 `thread/resume` 核對有效值：**gpt-6-astra / xhigh**；approval policy `on-request`；workspace-write sandbox、network access false。未使用 API Key 模型或靜默改模型。

1. 早期直接 App Server 隔離 smoke：實際產生加總程式及測試，5 項通過，獨立再測 5 項通過。
2. 經新版 MCP `autodev_submit`：實際產生加總程式及 8 項測試，Codex 與獨立執行均通過。同 request key 重送得到相同 job／turn。
3. 停止並重啟新版服務後，經 `autodev_continue` 恢復**相同 thread**，新增平均值功能；保留原功能，16 項測試由 Codex 及獨立執行均通過。同續辦 request key 重送也未重複派送。
4. 兩輪均可讀取完整 manifest 的原始條件、實際 diff、App Server 執行證據及 source identity。結果保持 **pending_chatgpt_review**；本機測試程式從未代填 review pass。

測試專案、個人 task identifiers 與原始 runtime 留在本機 ignored 目錄。此處不公開私人工作區路徑或憑證。

## 重開機後檢查與限制

本輪遇到使用者電腦強制重新開機。回來先查 Git、既有計畫雜湊、產品編譯及真實測試證據；沒有觀察到版本庫或已保存證據損毀。舊 EXP-003 契約維持原雜湊，沒有重跑舊 watcher。Windows OS mutex、異常死亡、初始化失敗及精確 turn 恢復另有行為測試；未知結果保留待處理，不推定成功。

Secure MCP Tunnel 需要 runtime API Key，已依使用者限制退出本輪方案。替代的 Cloudflare Quick Tunnel 2026.8.2 已從官方 release 下載、比對 SHA-256；尚未因安裝而啟動公網連線。

**尚未完成：**真正 ChatGPT 外掛 OAuth 掛載、唯讀呼叫、已授權寫入、親自讀完整證據並記錄審查。公開開發連線需由使用者確認新增存取後再執行；不能把本機 SDK client 稱為 ChatGPT。

免費 Quick Tunnel 重啟網址更換，gateway 重啟撤銷 OAuth grants；固定日常入口尚未完成。iOS 與聊天回覆結束後自動喚醒原聊天未驗證。OAuth authority 是個人開發模式，並非已稽核的多使用者身分平台。

## 重現及恢復

從儲存庫根目錄執行 `npm.cmd run check`；已啟動核心時可執行 `node --import tsx scripts/verify-local-mcp.ts`。`npm.cmd run test:real` 會使用目前 Codex 訂閱額度建立另一個隔離測試任務，必須在願意消耗額度時才執行。

`scripts/live-mcp.ts` 是本輪測試驅動器，需已註冊的 `acceptance` 隔離專案；它不應當作一般專案入口或 ChatGPT 審查器。日常入口及遇到 `recovery_required`／`uncertain` 的處理見 [Windows 指南](INSTALL-WINDOWS.md) 與 [架構](ARCHITECTURE.md)。保留 runtime 再診斷，不清空它來重試相同未知請求。
