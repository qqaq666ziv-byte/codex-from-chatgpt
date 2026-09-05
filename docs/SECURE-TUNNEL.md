# Secure Tunnel 候選入口與 Windows 交付

2026-09-05，AutoDev 0.4.1，延續 `codex/autodev-product` 的 `cc18c408f1431336f4ba673c4d26c81b68aa4f91`。

本版已實作候選 transport、Windows 管理與測試，**尚未成為固定日常入口**。啟用被成本關卡阻擋；即使解除成本關卡，OAuth 瀏覽器授權入口仍須完成固定化及一般 ChatGPT 驗收。Quick Tunnel 和歷史 jobs/evidence/reviews 保留。不能把下列本機原生測試當作新 ChatGPT E2E。

## 決策與證據

官方 Secure MCP Tunnel 提供固定 tunnel identity 與向外連線，適合私人 AutoDev。runtime key 用於控制端認證，與 Codex 的模型計費登入分開；本產品仍只接受 App Server 的 `account.type=chatgpt`，保持 `gpt-6-astra`／`xhigh`，不把 Tunnel key 傳給 Codex。[官方 Tunnel 文件](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)

當日官方指南、價格資料及可見帳號費用頁沒有建立「此用法零新增費用」的充分證據。**沒有列價、免費試用狀態、沒有 API 餘額都不等於免費保證。** 因此本次未建立／使用 runtime key、未對 OpenAI tunnel control plane 發請求。安裝、配置、診斷及隔離測試沒有啟用付費服務。[官方 API 價格](https://developers.openai.com/api/docs/pricing)

OAuth 繼續保留。官方將 noauth 視為匿名；Tunnel wire contract 未承諾可信的穩定 end-user subject，不能以自稱 header、MCP session 或 tunnel ID 代替 reviewer identity。[App 認證](https://developers.openai.com/plugins/build/auth)、[v0.0.14 wire contract](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/protocol.md)

候選路徑是：ChatGPT → 既有 Secure Tunnel → 官方 client → 既有 loopback OAuth gateway → AutoDev core → Codex App Server。保留 issuer/grant 身分、HMAC body assertion、nonce、完整證據收據與持久 review；未改 job/evidence/review 狀態機。靜態 secret header 不能代表終端使用者，且官方 client 允許轉送 header 覆寫靜態值，沒有採用這種替代。[header 實作](https://github.com/openai/tunnel-client/blob/v0.0.14/pkg/mcpclient/internal/context.go)

**固定入口尚有第二個限制**：OAuth browser authorization 不會自動經 Tunnel，現有 gateway 的瀏覽器頁仍使用 Quick Tunnel；gateway 的 DCR/grants 在完整重啟後失效。目前不能刪 Quick Tunnel、承諾開機免重新授權，或設定本候選路徑為 default。需要有零新增費用且穩定的授權入口，或官方提供並驗證等效的可信身分機制，再完成一般 ChatGPT E2E。[官方 OAuth 路由說明](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/connectors.md#oauth-protected-connector-behavior)

## 本機介面

從 AutoDev 產品根目錄執行。`setup` 只安裝固定 `tunnel-client v0.0.14` Windows x64 archive，核對 archive／exe SHA-256；不建立遠端 tunnel。來源與完整雜湊見 [SOURCE.md](SOURCE.md)。實驗用現有官方 binary 已驗證，不安裝全域工具。

```powershell
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 setup
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 configure -TunnelId '填入既有Tunnel-ID'
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 doctor
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 status
```

configure 只保存 `.runtime/secure-tunnel.json`，預設 `cost.status=unverified`；已存在的 Tunnel ID 不允許被另一個 ID 靜默取代。本輪已從使用者既有 AutoDev Tunnel 設定本機 ID；私人 ID 不放進 Git 或報告。health 預設 8796、產品管理端 8797，均只監聽 loopback；與既有服務衝突就拒絕，不停止占埠程序。

`doctor` 是離線診斷，只顯示 binary checksum、是否配置、成本狀態與是否存在 DPAPI credential。**沒有呼叫官方會使用 key 的 `tunnel-client doctor`**。

只有取得官方適用於本帳號／用法的零新增費用證據後，管理者才能於本機保存判定。`ConfirmZeroAddedCost` 是對已有證據的明確確認，不是同意可能付費；程式不會因填了網址就自行認定官方免費，也不接受秘密或 query string 作證據網址。

```powershell
# 先取得官方零新增費用確認；未確認時不要執行以下步驟。
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 configure -TunnelId '同一個既有Tunnel-ID' -ZeroCostEvidenceUrl '適用的官方文件或支援回覆網址' -ConfirmZeroAddedCost
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 credential
```

credential 只在本機以隱藏輸入接收受限制的 runtime key，保存 Windows current-user DPAPI 密文及私人 ACL。勿把 key 貼進聊天；不使用 admin key。key principal 只需要 Tunnels Read + Use；不啟用模型權限或付費項目。[官方權限](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/permissions.md)

啟用、configure 與 credential 儲存共用生命週期 mutex。start 必須在鎖內重新驗證成本、binary、既有 core 與 OAuth gateway 程序身分後，才解密 credential。原生子程序環境從白名單建立，排除繼承的 OPENAI_API_KEY、admin key、profile、proxy credential 與不安全 logging 設定。

```powershell
# 既有 core、OAuth gateway 已在運行，而且已通過成本關卡後：
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 start
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 status
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 restart
pwsh.exe -NoProfile -File .\scripts\secure-tunnel.ps1 stop
```

start 建立隱藏 supervisor；run 是前景診斷形式。Windows 10 以上使用 Job Object，在 CreateProcess 內原子綁定原生程序，核對後才 Resume；supervisor／helper 異常退出時，OS 關閉整個 job 的子程序，避免憑證程序殘留。stop 核對 PID、建立時間、執行檔、checkout entry、instance 及受認證 HTTP 身分，只有確認 job 與 descendants 全數關閉才回報成功。啟動取消會等待未完成的 listen／launch 收尾後才釋放 mutex。Core、gateway、job 和審查不因停止 Tunnel 被刪除。重連 backoff 使用官方 client；沒有自己重送 Codex 任務。[Windows Job List](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)

狀態分為本機 health、local readiness、proxy route、近期成功 polling、core／gateway readiness，以及 ChatGPT E2E。`/readyz` 是純文字，且 OAuth challenge 也可能 ready；`direct/healthy` 只是網路路徑。只有本次啟動後、90 秒內的 `commands_poll_last_successful_timestamp_seconds` 能標為近期 poll 成功，仍不代表 ChatGPT 完成驗收。[health](https://github.com/openai/tunnel-client/blob/v0.0.14/pkg/runtimehealth/health.go)、[poll timestamp](https://github.com/openai/tunnel-client/blob/v0.0.14/pkg/controlplane/internal/metrics.go)

本輪選擇可一鍵啟動的本機程序，不設排程、Startup 或 Service：在成本與固定 OAuth 尚未成立前，自動啟動只會自動恢復未驗收的路徑。整機 reboot、登入後常駐與睡眠恢復均保留未驗證標記。

## 更新、備份與 rollback

core 日常 start/status/stop 仍用 `scripts/autodev.ps1`；Quick Tunnel recovery 仍用 `scripts/connect-chatgpt.ps1`。目前已啟動的舊服務未被本輪停止或重啟。

新增離線備份介面。先完成或處理既有任務，再明確停止候選 Tunnel、Quick gateway 與 core：

```powershell
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 backup
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 verify-backup -BackupId 'backup輸出的ID'
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 update
```

update 先建立並驗證 `.backups/<id>/runtime` 與 SHA-256 manifest，再安裝 lockfile、typecheck、test、build。持有 core/gateway/secure 三個 writer mutex；拒絕活動程序、占埠、活動／recovery job、pending dispatch、錯誤 checksum 及未知 state schema。保留原有 uncertain journal。備份包括 registry、state、evidence、持久 review、Tunnel 設定及 DPAPI；排除 process、lease、log、暫存檔。

失敗 build 會保留 `build-incomplete.json`，start 拒絕啟動半成品。更新不自動 fetch、checkout、啟動或更換 transport；本輪 dependency versions 完全不變。

```powershell
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 restore -BackupId '已驗證的ID'
```

restore 先驗來源，備份當前狀態，原 runtime 另保留於私密 `previous-runtime`，再換入 verified snapshot；不覆寫目前損壞／未知 schema，不刪原證據。它只還原 runtime，不還原專案程式、Codex 帳號、遠端副作用或 dependency，因此會要求選定相容 source 並成功 update 後再 start。DPAPI 密文依賴同一 Windows 使用者，不是可跨帳號搬移的明文 key。

回到 `cc18c40`：先保存 Git 未提交修改、用本版 backup 驗證並停止所有程序，再由已授權的本機 Git 操作選回 `cc18c408f1431336f4ba673c4d26c81b68aa4f91`，按該版 update/build 重建。不用 reset --hard，不刪分支，不直接用未知舊 schema 覆蓋現態。本版未改 core 持久 state schema；若需 state rollback，先使用本版 restore 並保留它建立的當前狀態副本。

## 一般 ChatGPT 最後驗收

[App metadata 與圖示](CHATGPT-APP.md) 已備妥。成本及固定 OAuth 問題解決後，在同一個既有 AutoDev Tunnel 建立／選取候選 App、OAuth 對碼、Refresh，先讀回原 job/manifest/review，再從一般「對話」交辦 acceptance 隔離專案的一個新任務。ChatGPT 要透過工具保存 request key、取得完整 artifacts、記錄 review，不能由人搬運 prompt/result 代替。

代表性任務可新增 `summarizeDurations(values)`：只接受非負有限數字陣列、空陣列回傳 count/total/mean 全 0、不得修改輸入，加入 node:test 覆蓋小數／空陣列／非法值。提交同一 request key 再查仍為同一 job；先嘗試未讀完 evidence 的 review 應被拒，再讀全證據並審查。最後重啟 core/client，使用同一 App/Tunnel 讀回已保存 job/review，勿重送 submit。本輪未執行這個新真實任務。

已驗證／未驗證／平台限制的逐項結果見 [SECURE-TUNNEL-VALIDATION.md](SECURE-TUNNEL-VALIDATION.md)。
