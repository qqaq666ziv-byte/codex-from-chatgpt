# AutoDev 0.4.2 固定入口

固定入口使用 Cloudflare Workers Free、Workers KV 與免費 `workers.dev` 位址。內部 Quick Tunnel 可以在重啟後更換位址；ChatGPT App 的 MCP URL 與 OAuth issuer 保持相同。既有 core 與 Codex 執行流程不變，沿用既有 ChatGPT／Codex 登入及 `gpt-6-astra`／`xhigh`。

2026-09-05 已從實際帳號 UI 確認 Workers Free／$0；固定 Worker 已部署，真實固定入口的 metadata 已就緒並通過本次 instance 核對。同日 17:23 已完成一般 ChatGPT 的 OAuth／端到端工作驗收：同一請求 key 重送保持同一 job／turn、Codex 完成變更、該工作 46 項測試通過、四份 artifact 完成，以及持久保存的 review pass。17:26 core 與固定 gateway／cloudflared 全部正常重啟後，同一 App 無重新 OAuth、無改 URL 即讀回相同任務、證據與 PASS。**完整驗收見 [FIXED-ENTRY-VALIDATION.md](FIXED-ENTRY-VALIDATION.md)**。固定入口為日常路徑；原 Quick App 明確標記為備援，沒有刪除原程序或歷史證據。

## 連線與秘密邊界

```text
ChatGPT App（固定 HTTPS workers.dev、OAuth）
  → Cloudflare Worker + 私有 KV 路由租約
  → 每次啟動獨立 AES-GCM 加密的 HTTP envelope
  → 本次程序擁有的 Quick cloudflared 通道
  → 本機 OAuth gateway（DPAPI 持久授權狀態）
  → 既有 AutoDev core → Codex
```

Worker 與 gateway 每次啟動共用新的 32-byte relay key。HTTP 方法、路徑、headers 與 body 經加密後才送往內部 Quick 位址，包含 OAuth bearer；即使舊 Quick hostname 日後被重新分配，也不能解出先前通道的請求。Cloudflare Worker 本身處理解密前的用戶端 HTTP，這不是對 Cloudflare 隱藏資料的端對端加密。

relay key 不傳給 cloudflared、不寫入本機檔案、不輸出；Worker 的 KV 私有路由記錄保存它及到期時間。本機公開 gateway 只接受加密的 `POST /_autodev/relay`。路由控制 secret 與 OAuth token、core token 各自分離；部署助手產生強隨機 secret，以 stdin 寫入 Worker secret `ROUTE_SECRET`，並以 Windows 目前使用者 DPAPI 保存至 `.runtime/fixed-tunnel-key.dpapi`，不需人工複製。

| 本機端點 | 用途 |
| --- | --- |
| `127.0.0.1:8798` | 加密 relay gateway |
| `127.0.0.1:8799` | 本機管理、OAuth 同意與停止 |
| `127.0.0.1:8800` | 本次 cloudflared 的 ready／Quick hostname 查詢 |

啟動先檢查連接埠占用，不會為騰出連接埠終止其他程序。固定入口使用獨立 lifecycle lease 與程序記錄，保留原 Quick 及 core。Windows Job Object 擁有本次 native 程序；supervisor 意外死亡時關閉本次 job。停止會核對程序路徑、命令、建立時間及 instance，並確認 native 已結束；失敗會保留證據，不回報成功。操作不需要重新啟動 Windows。

## 首次設定

以下命令在 `product/autodev` 目錄的 PowerShell 執行，支援 Windows PowerShell 5.1 與 PowerShell 7。先沿用既有產品安裝及 core 設定；本輪不建立新模型 key。

```powershell
npm.cmd run build
npm.cmd ci --prefix edge --no-audit --no-fund
.\scripts\cloudflare.ps1 login
.\scripts\cloudflare.ps1 status
```

部署工具固定為 `edge/package-lock.json` 中的 **Wrangler 4.129.0**，不使用全域 Wrangler 或隱式下載最新版。Cloudflare 登入資料存於工作區私人 CLI 目錄。若目前 shell 的腳本執行政策不允許直接執行，可對已核對的單一腳本使用例如 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\cloudflare.ps1 status`；這不修改機器政策，也不能解除 Windows Application Control 對 EXE 的封鎖。

先確認登入帳號仍為 Workers Free，並符合下節六項費用條件，再執行：

```powershell
.\scripts\cloudflare.ps1 deploy -ConfirmWorkersFree
.\scripts\fixed-tunnel.ps1 setup
.\scripts\autodev.ps1 status
```

`deploy` 會保留同一 Worker／KV 身分，部署固定入口、同步路由 secret、保存固定 origin 與成本證據，成功後才解除部署 fence。此確認旗標代表對實際帳號方案及六項條件的確認，不會向 Cloudflare 購買或升級方案。`setup` 安裝或核對固定版 **cloudflared 2026.8.2** 及 SHA-256，不啟動通道。若 core 尚未啟動，再執行 `.\scripts\autodev.ps1 start`；已運行的 core 保持原狀。

```powershell
.\scripts\fixed-tunnel.ps1 start
.\scripts\fixed-tunnel.ps1 status
.\scripts\fixed-tunnel.ps1 connection-info
```

`connection-info` 是明確在本機顯示 MCP URL 與 OAuth metadata URL 的命令，供首次建立 ChatGPT App 使用；一般狀態輸出不顯示私人 origin、Quick URL、secret 或請求內容。以固定 MCP URL 建立／設定 App，使用 OAuth，依授權頁上的 request ID 與 verification code 在本機核對後同意。後續固定入口重啟不需要再建立 App。App 的實際工具讀寫、審查身分與重連行為依最新驗收記錄判定。

## 日常命令

一般日常只需啟動既有 core、啟動固定入口及查看狀態；不需每天重新登入 Cloudflare、部署、設定 credential 或建立 ChatGPT App。

完成首次設定後，雙擊產品根目錄的 [Start-AutoDev.cmd](../Start-AutoDev.cmd) 即可。它先核對既有設定、成本證據及期限、固定 cloudflared 雜湊、必要檔案與未完成狀態標記，再依序執行 core `start`、固定入口 `start`，最後檢查本次連線準備狀態。成功後可關閉該命令視窗，已啟動的背景服務會繼續運行。

```powershell
# 與雙擊相同，完成後不等待按鍵；適用既有 PowerShell 視窗。
.\Start-AutoDev.cmd --no-pause

# 或直接執行日常入口，沿用目前的 PowerShell 5.1／7。
.\scripts\start-daily.ps1
```

一鍵入口不安裝、不部署、不修改成本確認或 credential；缺少前置條件時停止並顯示診斷命令。它序列化同工作區的一鍵啟動，重複雙擊不會再開始第二次啟動流程。某步失敗後保留已運行的 core 與其他入口，使用下表的 `status`／`doctor` 查明原因，不自動回滾或強殺程序。程序退出碼 `0` 表示本次連線準備檢查通過，`2` 表示唯讀前置檢查未通過，`1` 可表示忙碌或狀態無法確認；子腳本的非零退出碼原樣回傳。關閉視窗不等於停止服務，停止時使用下表命令。

| 命令 | 行為 |
| --- | --- |
| `.\scripts\fixed-tunnel.ps1 setup` | 首次安裝或核對固定 cloudflared；固定入口須先停止。 |
| `.\scripts\fixed-tunnel.ps1 start` | 背景啟動本次 supervisor／job；已運行時回報目前狀態。 |
| `.\scripts\fixed-tunnel.ps1 status` | 分別顯示程序、native、core、路由租約與外部 metadata 狀態。 |
| `.\scripts\fixed-tunnel.ps1 doctor` | 檢查設定、成本、工具及連線狀態，輸出固定且去敏的診斷。 |
| `.\scripts\fixed-tunnel.ps1 stop` | 只關閉本次固定入口擁有的程序與連接埠，保留 core 及原 Quick。 |
| `.\scripts\fixed-tunnel.ps1 restart` | 確認停止成功後重新啟動；固定 issuer 及有效 OAuth 狀態保留。 |
| `.\scripts\fixed-tunnel.ps1 -Action approve -RequestId '<request-id>' -VerificationCode '<verification-code>'` | 核對授權頁上的兩個值後同意該次 OAuth 請求。 |
| `.\scripts\fixed-tunnel.ps1 -Action deny -RequestId '<request-id>' -VerificationCode '<verification-code>'` | 核對同一組值後拒絕該次 OAuth 請求。 |
| `.\scripts\fixed-tunnel.ps1 connection-info` | 在本機明確顯示固定 App 設定 URL。 |
| `.\scripts\fixed-tunnel.ps1 run` | 前景執行，供需要直接控制程序生命週期時使用。 |
| `.\scripts\fixed-tunnel.ps1 help` | 查看命令說明。 |

授權 request ID 與 code 取自當次授權頁；`status` 只顯示待同意數量。這兩個值不是 core 的工作審核 request，也不能用來代替 Codex 執行審核。

`configure` 與 `credential` 是手動設定／修復介面，正常部署助手已代為完成。修改前須停止固定入口，並維持同一個既有 HTTPS `workers.dev` origin。只設定 origin 會保存為成本未確認狀態，不能啟用：

```powershell
.\scripts\fixed-tunnel.ps1 configure -WorkerOrigin 'https://<worker>.<account>.workers.dev'
```

已有本帳號的當前官方證據時，可一次確認完整條件：

```powershell
.\scripts\fixed-tunnel.ps1 configure `
  -WorkerOrigin 'https://<worker>.<account>.workers.dev' `
  -EvidenceUrl 'https://developers.cloudflare.com/workers/platform/pricing/' `
  -CostBasis free-tier `
  -ConfirmAccountPlan -ConfirmNoNewPaymentMethod -ConfirmNoAutomaticCharges `
  -ConfirmNoPaidUpgrade -ConfirmQuotaStops -ConfirmNoAutoRecharge -ConfirmNoPurchases
```

公開價目頁不能自行證明本帳號方案；確認者仍須核對帳號 UI。`free-credits` 另須提供有效的 `-CostExpiresAt` ISO 時間。`credential` 會先通過成本與停止檢查，再以隱藏輸入讀取「既有 Worker 的路由控制 secret」並 DPAPI 保存。不要填入 Cloudflare 管理 API key 或模型 key；若無法確保遠端及本機 secret 一致，使用原部署助手修復。

## 零新增實際費用

API、API key、雲端服務、免費 credits 與免費 quota 都可採用；不要求永久免費承諾。啟用判準是本帳號、本方案與本用途不會產生新增實際費用，且同時符合：

1. 不需要新增付款方式。
2. 免費額度耗盡不會自動扣款。
3. 不會自動升級付費。
4. 額度耗盡時停止，沒有計費 fallback。
5. 不開啟 auto-recharge。
6. 不購買 credits 或付費方案。

成本預設 `unverified`，欠缺完整證據即拒絕啟動。免費 credits 必須有到期日，期限到達時拒絕啟動或關閉運行中的入口。Free 方案的帳號確認不等於未來方案永遠不變；日後手動變更帳號或用途時需重新核對。完整政策見 [COST-POLICY.md](COST-POLICY.md)。

本次選擇 Workers Free＋KV，不買網域，不啟用付費服務；免費配額用完導致請求失敗／入口不可用，不自動購買、充值、升級或切換付費通道。OpenAI Secure MCP Tunnel 已有候選實作，但其適用成本及硬停止證據仍未確定，沒有啟用 runtime key。ngrok 官方簽章程式被本機 Windows Application Control 封鎖，沒有繞過，也未保留不可運行的 ngrok 產品通道。

## 準備狀態、租約與限制

| 狀態 | 可以確認的範圍 |
| --- | --- |
| `process_running`／`native_process_running` | 本機程序仍在且身分相符。 |
| `native_ready` | 本次 cloudflared 已有可用連線。 |
| `core_ready` | 既有本機 core 的 ready 檢查通過。 |
| `worker_route_ready`／`route_lease_valid` | Worker 有尚未到期的路由；這可能仍是 KV 傳播中的舊值。 |
| `external_metadata_ready` | 固定 issuer 的 metadata 相符，且經加密 relay 回傳本次 instance 證明。 |
| `ready_for_chatgpt_probe` | 可開始實際 ChatGPT 驗收；不是 E2E 成功宣告。 |
| `chatgpt_e2e: not_verified` | CLI 只做連線探測，不載入外部 ChatGPT 驗收紀錄；實際驗收結果見本文件開頭連結。 |

路由每 20 分鐘續租，最長有效 60 分鐘，且不超過成本證據到期日。續租失敗或租約到期會關閉本次通道；遲到的續租回應不能復活已關閉的程序。正常停止後 KV 可能暫留舊租約，但本機 job 已停止，不能把舊路由健康旗標視為可用連線。

`PUT /_autodev/route` 的成功只證明路由已寫入。啟動會等待 KV 傳播，最多 90 秒確認本次 instance 的外部 metadata；舊 gateway 的健康回應不能通過。加上 native 通道建立及程序核對，背景啟動等待上限為 240 秒。逾時先執行 `status`／`doctor`，避免重複啟動或自行刪除程序記錄。

2026-09-05 核對的官方 Free 配額如下；同帳號其他用途及公開流量也會消耗配額。

| 項目 | 免費上限／本版本限制 |
| --- | --- |
| Workers requests | 每日 100,000 次。 |
| Workers CPU | 每次 invocation 10 ms CPU，不是整個網路等待時間。 |
| KV reads | 每日 100,000 次。 |
| KV writes | 每日 1,000 次；單一路由持續運行每 20 分鐘續租約 72 次／日，重啟及其他操作另計。 |
| 應用請求與回應 body | 各自最多 2 MiB；加密 envelope 另有上限。 |
| 串流 | 本版本不支援 SSE；採有限大小的 HTTP／JSON 回應。 |

Workers 與 KV 配額見 [Workers 價格](https://developers.cloudflare.com/workers/platform/pricing/)及 [KV 價格](https://developers.cloudflare.com/kv/platform/pricing/)。KV 免費額度每日 00:00 UTC 重設，超額後同類操作失敗。大 payload 的 JSON、base64 與加解密是否能持續符合真實 Workers Free 的 10 ms CPU，仍須正式環境量測；本機功能測試及 2 MiB 大小檢查不能代替這項證據。

## OAuth 持久化與復原

固定 gateway 使用 `.runtime/fixed-oauth.dpapi` 保存 DCR client、grant、雜湊 token 及必要的已使用狀態，綁定目前 Windows 使用者與固定 issuer。有效 access token 最長 10 分鐘；同一 grant 最長 8 小時，最多 64 次 refresh rotation。有效授權可跨正常 gateway 重啟保留，refresh 沿用同一 grant 身分。grant 到期或 rotation 用完後，從既有 App 重新授權並完成本機同意；不需建立新 App。此 grant 身分不等同單一 ChatGPT 對話 ID。

待同意請求與尚未兌換的 authorization code 不跨重啟保存；中途重啟時重新發起該次授權流程。不要依賴舊頁面的 code。

| 情況 | 處理方式 |
| --- | --- |
| `.runtime/fixed-oauth.dpapi.pending` 存在 | 表示授權狀態寫入曾中斷。停止服務並保留檔案，依復原流程確認一致性；**不可單獨刪除 `.pending`**，否則可能讓舊 snapshot 中的授權重新生效。 |
| 從備份還原 OAuth 狀態 | 還原流程將舊 OAuth 檔隔離為 `fixed-oauth-restored-<uuid>.dpapi` 證據，避免復活舊 grant／refresh token。從既有 App 重新授權。 |
| `.runtime/fixed-deploy-incomplete.json` 存在 | 遠端 Worker／secret 與本機設定可能未同步。啟動會在讀 credential 前拒絕；確認固定入口已停，重新執行同一部署助手修復，只有完整部署成功才清除 fence。 |
| 程序身分不符或 shutdown 未確認 | 保留 lease／程序證據，執行 `doctor` 並查明占用來源；不依 PID 猜測、強殺其他程序或手動刪除記錄。 |

部署 fence 存在時，`configure`／`credential` 可供完整修復使用，但不會自行解除 fence。備份、還原及更新會拒絕未完成的部署或 OAuth 寫入狀態。DPAPI 檔、CLI 登入資料、私人連線資訊與 runtime 診斷都留在受保護且被 Git 忽略的 runtime，不放進公開報告。備份或換機不能假設另一 Windows 使用者可直接解密。

原 Quick 入口在固定 ChatGPT 實際驗收前維持可用；切換時依最新驗收記錄操作，不以重新開機、刪除 App 或清空授權檔作為日常修復步驟。
