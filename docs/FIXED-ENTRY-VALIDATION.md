# AutoDev 0.4.2 固定入口驗收

日期：2026-09-05，Asia/Taipei。接續 `codex/autodev-product` 的 0.4.1 `cb7fc90490570a3ad0ae4cd79c50a3ae90115105`；原 `cc18c408f1431336f4ba673c4d26c81b68aa4f91` 歷史保留。此文件只保存去敏結果，不包含實際 public hostname、帳號 ID、App ID、私人對話全文、OAuth／route secret 或 raw runtime log。

## 結果

**固定入口已完成真實一般 ChatGPT E2E，以及 core＋gateway＋cloudflared 重啟後同 App 讀回。** 日常主要入口使用 Workers Free 固定 HTTPS，原 Quick App 保留為 development recovery。OpenAI Secure MCP Tunnel 因用途費率及零超額費用仍無充分證據，保持未啟用；未建立或使用其 runtime key。

採用 API、雲端或免費 credits 的資格依 [COST-POLICY.md](COST-POLICY.md) 判定，不以技術類別排除。本次已在實際 Cloudflare 帳號確認 Workers Free／$0，只使用免費 Worker、KV、workers.dev 與 cloudflared，不新增付款方式、不升級付費、不購買、不開 auto-recharge。Free 配額耗盡會拒絕操作，沒有付費 fallback。模型仍用現有 ChatGPT／Codex 訂閱登入。

| 驗收層次 | 當日結果 |
| --- | --- |
| 官方固定工具 | cloudflared 2026.8.2 SHA-256 核對；Wrangler 4.129.0 本地 lockfile；沒有隱式下載 CLI。 |
| 真實 Worker | 私有路由 secret、KV、固定 workers.dev 部署；Worker metadata issuer 及 gateway instance 核對成功。 |
| App 掛載 | 新 AutoDev 固定 App，OAuth DCR＋PKCE、本機對碼同意，Refresh 後 9 個工具。 |
| 一般 ChatGPT 唯讀 | 原 acceptance registry、Astra／xhigh、median job 與原 review PASS 讀回。 |
| 一般 ChatGPT 新任務 | 同一聊天完成 submit、duplicate submit、46 項測試、四份 artifact、review PASS 與 status 查核。 |
| 實際程序重啟 | 正常停 fixed gateway/cloudflared，正常重啟 core，再啟動固定入口；17:26 同一 App 無 OAuth 重連、無 URL／App 修改即成功讀回。 |
| 真實日常入口 | `Start-AutoDev.cmd --no-pause` exit 0，確認既有 core 與固定入口 ready，未重複建立程序。 |
| 整機 Windows reboot | 未在本輪執行；重啟程序的成功不能代替整機 reboot。 |
| iOS／聊天結束後自動喚醒 | 未驗證；沒有繞過平台或另造 API 模型冒充一般 ChatGPT。 |
| App 圖示 | repo 已有 256×256、2,755 bytes PNG。Chrome 自動上傳回 `Not allowed`；未擴大 extension 檔案權限。 |

## 新代表性任務

只操作已註冊 acceptance 隔離專案。一般 ChatGPT 自行整理需求與驗收，要求新增 `durations.js`／`durations.test.js`，匯出 `summarizeDurations(values)`：稠密非負有限數值陣列、空陣列結果、count／total／min／max／mean、無效輸入 TypeError、total 溢位 RangeError、不修改輸入及保留既有功能。未安裝依賴、不連外、不 commit／push 該隔離專案。

| 證據 | 值 |
| --- | --- |
| Job | `67f8def0-1716-4b46-8332-4fa788cd6554` |
| Thread | `01a070dc-ef05-7bc2-bace-f3e5c619161b` |
| Turn | `01a070dd-0189-7ed2-90d7-ce4c3afde14c` |
| Manifest | `a4fdbfd84bbcb295cc8240fd2ebb37069c0342479aa1ccf4395718b9401a898a` |
| Revision／round | 20／1 |
| Submit key | `acceptance.durations.20260905.fixed.submit.v1` |
| Review key | `acceptance.durations.20260905.fixed.review.v1` |
| 實際模型／effort | `gpt-6-astra`／`xhigh` |
| Diff | 2 個新增檔案、180 insertions、0 deletions；原有 8 檔 before／after SHA-256 不變。 |
| 測試 | `node --test`：46 passed、0 failed、exit 0，包含原 sum／mean／median。 |
| 最終 execution／review | completed／pass，review journal succeeded。 |

ChatGPT 的工具清單記錄第二次相同 key／相同 body submit 回相同 job／thread／turn；沒有新增 execution turn。四份 artifact（`changes.patch`、`execution.json`、`requirements.json`、`source-identity.json`）皆實際回 `done: true`、`nextCursor: null`，本次各一頁。主代理另外在該聊天工具詳情逐份核對完成旗標、review 回應及最後 status；本機官方管理 status 也獨立確認 review journal succeeded。

ChatGPT 沒有發現真實缺陷，因此沒有 continue 或捏造 repair。這是同一普通聊天的實作交辦與獨立審查，不把 Codex 自評當作 ChatGPT review；沒有使用本機 MCP client 冒充這項 E2E。

## 重啟與既有狀態

確認沒有 active job 後，依序執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\fixed-tunnel.ps1 stop
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\autodev.ps1 restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\fixed-tunnel.ps1 start
```

三步均成功，core PID 與固定 gateway instance 都已改變；同一 App URL／ID 與有效授權保留。一般 ChatGPT 再實際呼叫 projects、未指定 job 的 status、durations evidence，核對相同 job／thread／turn／revision／manifest、review PASS 及四份 artifact 名稱／雜湊。未重新 OAuth、未重新建 App、未重新執行任務。核心重啟清除未提交的讀取收據，已持久化 review 保留。

原 median job `072feef0-23d5-4996-bb41-7ced13f3a020` 與 manifest `73874ba0eb1abf2d22004634fd81b18d42577ae64f206a4acfc0f83707da59ac` 仍在。新任務修改同一專案的 source fingerprint 後，其目前 review 適用狀態正確成為 `stale_review`；歷史 review.v2 journal 的 PASS 仍 succeeded，原 review.v1 uncertain 也沒有被刪除或重播。這不是重啟遺失審查。

manifest 的 immutable metadata 與 Codex final_message 仍保留封存時的「待 ChatGPT 審查」，最新持久 review 以 status 為準；不能為了顯示一致而改寫歷史證據。

## 工程驗證

環境：Windows，Node 24.16.0、npm 11.13.0、Codex CLI 0.153.3、Windows PowerShell 5.1.26100.9278、PowerShell 7.6.5。

最終 `npm.cmd run check` **exit 0**：typecheck、核心 **233 passed／0 failed／2 skipped（235 total）**、Worker **29 passed／0 failed**、build。核心測試約 297 秒；兩個 skip 是 opt-in App Server handshake 與非 Windows lock，不是失敗。合計 262 項通過、2 項條件性略過。

`npm.cmd run check --prefix edge` 亦 **exit 0**：29 Worker tests、generated bindings 核對、Wrangler 4.129.0 dry-run，未改遠端資源。針對本輪風險的驗證包括：

- Worker 29／29：真實 WebCrypto、租約與 quota／KV 失敗、嚴格公開路徑、HTTPS redirect、AES tamper／replay、body／timeout 上限、原生 fetch receiver。
- CLI 13／13：dotenv 與 shell secret 隔離、顯式空 env file、直接執行真正 CLI PID、timeout 清理、輸出上限、Node 版本，以及 login／status 的 timeout／truncated code 0 不得成功。
- Windows backup：PS 5.1／7 的實際備份、hash／ACL、restore、tamper、活躍 writer、OAuth／deploy fence、volatile exclusion 與 OAuth quarantine。
- Windows fixed launcher：PS 5.1／7 的成本、fence、並行設定、DPAPI、程序生命週期；另以 native Job Object 測試涵蓋 supervisor 結束時停止本次子樹。
- Windows daily launcher：PS 5.1／7 的順序、失敗碼、ready／壞 JSON、並行鎖與含中文、空格、`&` 路徑 CMD。
- OAuth state：真 DPAPI 跨 Node 程序還原、refresh replay 持久撤銷、issuer／clock／ciphertext／schema 不符、stale writer、寫入 fence 與失敗不發 token。
- 實際 Worker module → HTTP gateway 整合：OAuth PKCE、local approval、refresh、穩定 grant HMAC、密文 public route、2 MiB 上限及斷線取消。
- 核心既有負面測試：未註冊／錯誤專案、錯誤身分、跨 grant／session receipt、未讀完 evidence、stale source／revision、duplicate／uncertain 不盲目重播。

以上是整合測試涵蓋範圍，獨立 focused 重跑不重複加總。`git diff --check`、公開檔案秘密排除與文件本機連結另外核對；runtime／tools／backups／CLI login 與隔離 acceptance 檔案不提交。

## 真實啟用發現與修正

Workers 的原生 `fetch` 以物件方法呼叫會因 receiver 不正確而失敗；本機注入的測試 fetch 沒有相同限制。改為保持原生呼叫方式的 wrapper，加入 receiver 敏感測試後，真正固定 metadata 與整條 ChatGPT E2E 都成功。另補固定失敗階段碼，回應不包含 URL、token 或 raw error。

部署使用精確 account／user read、Workers scripts／routes 與 KV write OAuth scopes；需要現有帳號初始化免費 workers.dev 子網域。部署及 route secret 更新未完整成功時保留 fence、拒絕啟動，重試沿用同一 Worker／KV 身分。CLI home 與環境隔離，明確空 env file 避免 Wrangler 自動讀工作目錄 `.env`；不讀或複製私人登入檔。

## 操作與 rollback

日常安裝／啟動／停止／診斷見 [FIXED-ENTRY.md](FIXED-ENTRY.md)，App 設定與 icon 見 [CHATGPT-APP.md](CHATGPT-APP.md)。Free 額度是同帳號共用，超限或供應商故障會使入口停止；沒有 SLA 或保證最大 2 MiB payload 在 Free 10 ms CPU 下永遠成功。此次一般任務與完整 execution artifact 實際傳送成功，未做壓力或真實配額耗盡測試。

回退時先等 active job 結束，停固定入口；需要回退 core 前也停止 core 與其他 gateway，保存未提交 source、製作並驗證私人 runtime backup。保留 0.4.2 加密 OAuth／部署資料，選取已知可用的 `cb7fc90` 或 `cc18c40` 於獨立 checkout；只有核對 state schema 相容、完成原版本 build 後才啟動。舊版不提供固定入口，需使用保留的 Quick recovery 並按其規則重新 OAuth／掛載。回退本機程式不等於回復已執行專案變更或遠端資源；不要刪 state、uncertain journal、fence 或證據來強迫成功。
