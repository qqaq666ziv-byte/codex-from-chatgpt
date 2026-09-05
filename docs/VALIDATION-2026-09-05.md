# 2026-09-05 驗收紀錄

版本：AutoDev 0.4.0 開發分支。本紀錄以所在 Git commit 為準，未宣告整個產品完成。

## 本機工程驗證

- `npm.cmd run check`：exit 0。TypeScript typecheck、163 項測試（161 passed、0 failed、2 skipped）、production build 通過。
- 兩项略過為預設不執行的真實 App Server 選用測試，以及目前 Windows 環境不適用的非 Windows 檔案鎖測試。選用 App Server 握手／thread list 曾以明確開關另外執行，1/1 通過；它不是實際交辦或 ChatGPT 審查。
- Windows PowerShell 5.1 與 PowerShell 7 均實測 ACL、原生命令引數、中文路徑、重複註冊、程序身分、啟停、occupied port、readiness 失敗及核准回覆。PS 5.1 行為測試只使用測試子程序的暫時執行政策，不變更系統政策。
- 涵蓋 request journal 的程序中斷／不重複派送、不可變證據與 UTF-8 分頁、資料破損拒絕、來源變更與遲到事件使審查失效、原 turn 恢復、模型／effort 不符拒絕、問題及權限核准往返。
- OAuth 驗證涵蓋 DCR／S256、精確 callback／client／resource 綁定、`ui_locales`、本機核對碼、code 重播、refresh 輪替／撤銷與 8 小時 grant 期限。
- gateway／HTTP 7 項整合通過：實際 AutoDev 與合成 executor，45 個全新 SDK clients 呼叫、每頁重新連線後完成四份 artifact 並記錄 review；跨 grant／直接本機 client 不得借用收據，HMAC 偽造／重播被拒絕，讀取紀錄閒置逾時後必須重新讀取，無效初始化與 40 次本機連線不耗盡容量。這些測試不冒稱來自 ChatGPT。
- review 純驗證在 journal pending 前執行；缺少讀取紀錄可補讀後重試同 key。來源／版本／測試限制仍有效，持久化故障仍保留 uncertain；原有不確定請求不因更新自動清除。
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

Secure MCP Tunnel 需要 runtime API Key，已依使用者限制退出本輪方案。替代的 Cloudflare Quick Tunnel 2026.8.2 已從官方 release 下載、比對 SHA-256；在使用者明確同意後啟動免費 HTTPS／OAuth 開發連線，僅提供已註冊的隔離驗收專案。未建立 OpenAI API Key、付費模型 API 或系統常駐服務。

## 真正一般 ChatGPT 呼叫與修復後審查

使用 ChatGPT 網頁實際外掛入口，明確選取「對話」而非預設的 Work。ChatGPT 當次介面顯示高思考強度；介面未提供精確 backend model ID，因此不把本機 Codex 的 gpt-6-astra／xhigh 當成 ChatGPT 模型證據。

1. OAuth 本機配對核准、callback 與九項動作 Refresh 成功。實際發現授權請求含 `ui_locales`，補上有界語言標籤支援並保留其他 OAuth 綁定檢查。
2. 一般 ChatGPT 真正呼叫 projects／status，接著提交 median 任務；本機 Codex 新增實作與測試，保留原 sum／mean 檔案。完整 `node --test` **30 passed、0 failed**，獨立再測亦為 30／0。沒有新增依賴、commit 或 push 驗收專案。
3. ChatGPT 取得同版四份 required artifacts 並嘗試保存審查。首次寫入回 uncertain，隨後連線累積碰到 32 session 容量。當時 durable review 仍是 pending，沒有以文字審查代填 pass。
4. 修正 gateway 跨 HTTP 身分與 transport 清理，將完整讀取紀錄綁定已驗證的 OAuth grant；review 純驗證先於 journal pending。完整工程檢查通過後重啟核心及 gateway，獨立確認原 job／thread／turn／manifest 仍在、review 未保存；保留原 uncertain key，不清除或自動重送。
5. 新 URL 重新掛載 OAuth 成功，但舊聊天呼叫新 app 仍回帳號連線錯誤。從新外掛正式「在聊天中試用」入口建立另一個**一般對話**，成功唯讀核對原 job，再親自讀完 requirements、changes、execution、source identity 四份 artifact，全部到 `done=true`。
6. 新聊天依原條件與實際證據呼叫 review，使用不同的已授權審查 request key，真正保存 **pass**；接續 status 再確認 completed／pass。本機另一個唯讀 MCP client 獨立確認同 job／thread／turn、round 1、revision 22、同 manifest 與 pass。這是接續原任務的恢復驗證，沒有把兩個 ChatGPT 聊天說成同一聊天的無縫循環。

本輪已具備真實 ChatGPT 的掛載、唯讀、交辦、完整證據審查及保存結果證據。私人聊天／job identifiers、失敗與恢復收據留在本機 ignored 驗收紀錄，公開文件不帶暫時網址、私人對話或 runtime 憑證。

免費 Quick Tunnel 重啟網址更換，gateway 重啟撤銷 OAuth grants；固定日常入口尚未完成。iOS 與聊天回覆結束後自動喚醒原聊天未驗證。OAuth authority 是個人開發模式，並非已稽核的多使用者身分平台。

## 重現及恢復

從儲存庫根目錄執行 `npm.cmd run check`；已啟動核心時可執行 `node --import tsx scripts/verify-local-mcp.ts`。`npm.cmd run test:real` 會使用目前 Codex 訂閱額度建立另一個隔離測試任務，必須在願意消耗額度時才執行。

`scripts/live-mcp.ts` 是本輪測試驅動器，需已註冊的 `acceptance` 隔離專案；它不應當作一般專案入口或 ChatGPT 審查器。日常入口及遇到 `recovery_required`／`uncertain` 的處理見 [Windows 指南](INSTALL-WINDOWS.md) 與 [架構](ARCHITECTURE.md)。保留 runtime 再診斷，不清空它來重試相同未知請求。
