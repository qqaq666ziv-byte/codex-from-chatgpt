# Windows 安裝、連線與接續

2026-09-05 的 0.4.1 已加入 [Secure Tunnel 候選入口、成本關卡與備份／還原](SECURE-TUNNEL.md)，但尚未啟用。下方 Quick Tunnel 是保留的已驗證開發／恢復路徑；新的固定入口不是完成狀態。圖示與 App 欄位見 [CHATGPT-APP.md](CHATGPT-APP.md)。

本指南從 **AutoDev 產品儲存庫根目錄**執行。一般 ChatGPT 負責規劃與審查，這部電腦上的 Codex 負責修改與測試。`plugins/autodev` 是搭配 MCP 使用的技能；單獨匯入技能不代表 ChatGPT 已連上本機。

## 本機安裝

需要已安裝的 Node.js 20 以上、npm、Git 與官方 Codex CLI，以及可執行本機腳本的 PowerShell。本機驗證時 PowerShell 7 可以執行，Windows PowerShell 5.1 的預設政策拒絕載入腳本，因此以下以 `pwsh.exe` 為預設。腳本也保持 5.1 相容，但只有在其政策允許的環境才能使用 `powershell.exe` 執行。本專案不修改系統執行政策、防火牆或開機常駐設定，也不全域安裝工具。若腳本被組織政策阻擋，依管理員提供的支援方式處理。

先使用官方登入介面，再安裝 lockfile 指定的專案依賴：

```powershell
codex login status
# 只有未登入時才執行：codex login
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 setup
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 add-project -ProjectId demo -ProjectName '示範專案' -ProjectPath 'D:\Projects\demo'
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 start
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 doctor
```

將範例 `ProjectPath` 換成明確授權的既有本機專案。`setup` 建立本產品的 `.runtime/config.json`，預設 `127.0.0.1:8790`、`gpt-6-astra`、`xhigh`；如果沒有指定連接埠且被占用，會選附近空埠。`setup -Port 8795` 可明確指定。既有設定不會被 setup 覆寫。服務啟動時會向 App Server 核對模型與 effort，無法使用時報錯，不靜默改模型或切換 API 計費。

只有本機 `add-project` 會增加 allowlist；ChatGPT 工具不能指定任意路徑。新增後在工作結束時 `restart` 載入新設定。設定、兩枚不同用途的本機 token、程序紀錄與任務證據放在 `.runtime`，先限制 Windows ACL 再寫入，並由 Git 忽略。不要把 runtime 複製到公開 issue、聊天或 Git。`doctor` 只顯示登入狀態、版本與經驗證的服務狀態，不印出 token。

## 一般 ChatGPT 的無 API Key 開發連線

本輪採用 **免費 Quick Tunnel HTTPS 加本機 OAuth gateway**，不需要 OpenAI API Key，也不代用 API 模型規劃或審查。Codex 繼續使用官方 ChatGPT 登入。登入 Platform 不是這條路線的先決條件，無須在 Platform 建立 tunnel 或 key。

Quick Tunnel 產生暫時公開的 HTTPS 網址；OAuth gateway 驗證通過的 MCP 請求才會轉送至本機 AutoDev。管理端點與 admin token 保持本機使用。這是一條**開發測試連線**：Cloudflare 不保證 uptime，重啟後網址會改變，必須重新掛載 ChatGPT；它不是固定網址的日常交付。Quick Tunnel 也不支援 SSE，本產品使用 JSON MCP 回應與狀態查詢。來源：[Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。

### 啟動與掛載

先依前節啟動 AutoDev 並確認 doctor 通過，再從產品根目錄啟動開發連線：

```powershell
pwsh.exe -NoProfile -File .\scripts\connect-chatgpt.ps1 setup
pwsh.exe -NoProfile -File .\scripts\connect-chatgpt.ps1 run
```

`setup` 只下載官方固定版本 `cloudflared 2026.8.2` 並核對 SHA-256，存入此產品的 `.tools`；不啟動通道。`run` 會啟動公開 HTTPS 開發入口，只轉送通過 OAuth 的 MCP 請求。預設本機 gateway 埠為 8792、獨立管理埠 8793，埠被占用即失敗，不終止其他程序。

保持此視窗開啟。在另一個 PowerShell 視窗查詢目前網址與 OAuth 狀態：

```powershell
pwsh.exe -NoProfile -File .\scripts\connect-chatgpt.ps1 status
```

使用保留的 Quick Tunnel 路徑時，將**這次 status 顯示的 MCP HTTPS URL**填入 ChatGPT 的 Plugins 開發者連線：Connection 選 Server URL，認證選 OAuth。Secure MCP Tunnel 另依本版成本關卡与驗收流程啟用，不能因 runtime key 用於認證就推論免費。不要關閉 OAuth 或把本機 admin token 貼進 ChatGPT。開發者模式與帳號平台確認仍由使用者處理；詳見 [官方 ChatGPT 連線流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

OAuth 瀏覽器頁面會出現本次授權請求與驗證碼。**只有你剛剛在 ChatGPT 主動發起連線、且瀏覽器頁面與本機待核准請求相符時**，才在本機執行：

```powershell
pwsh.exe -NoProfile -File .\scripts\connect-chatgpt.ps1 approve -RequestId '這次實際request-id' -VerificationCode '這次瀏覽器顯示的驗證碼'
```

回到原 OAuth 瀏覽器頁面完成該次授權，再回 ChatGPT 檢查發現的工具。驗證碼只在本機輸入，不要貼進聊天、公開報告或指令範例。陌生、過期或無法對上的請求不核准；重新檢查自己發起的那一次。這項核准只允許該客戶端連上既有 AutoDev 範圍，不能增加專案 allowlist，也不能代替個別 Codex 執行權限核准。

### 常見連線問題

- 初次建立連線後，ChatGPT 的 Actions 可能暫時顯示沒有工具。完成 OAuth 後，在該連線的設定頁按 **Refresh**，重新取得工具清單；目前應有 9 個 AutoDev actions。看到清單後仍需完成下節的實際呼叫驗證。
- ChatGPT 可能在授權網址附加 `ui_locales=zh-TW`。本版接受這項選用語系提示，它不會改變核准、權限或 PKCE 驗證。若舊版 gateway 因此回報 `invalid_request`，依「更新與回復」更新程式並重新啟動連線，再從 ChatGPT 發起新的 OAuth；不要手動改寫授權網址。

### 真實驗證

從外掛詳細頁按「在聊天中試用」後，明確選取 **「對話」單選項**。本次測試帳號預設進入 Work；切換後網址中的 `surface=work` 可能未立即更新，因此以頁面已選取「對話」為準。

在新對話輸入 `@AutoDev`，從清單選取本次有效連線的外掛，確認輸入框內出現 AutoDev 外掛標籤，再交辦：

> 請使用 AutoDev 列出已登記專案與目前任務，回報實際工具結果，先不要修改檔案。

成功應看見 `autodev_projects` 與 `autodev_status` 的真實工具呼叫。接著指定已授權的隔離測試專案，交辦具體修正與測試。最後要求 ChatGPT 取得該 job 的 evidence manifest、逐頁讀完每份 artifact，再給 review verdict。

掛載、唯讀、寫入及審查必須分別記錄。啟動程序、取得 HTTPS URL 或本機測試通過，都不等於真正 ChatGPT 已完成驗收。尚未完成的層次應保持未驗證／待審。`plugins/autodev/skills/autodev-workflow/SKILL.md` 提供規劃與審查流程；匯入技能本身不會建立連線、修改 marketplace 或增加權限。

### 停止、重新連線與限制

```powershell
pwsh.exe -NoProfile -File .\scripts\connect-chatgpt.ps1 stop
```

stop 結束本次開發 HTTPS 連線，本機任務與證據仍保留。OAuth gateway 的客戶端註冊（DCR）與授權只存在於記憶體；gateway 停止或重啟後，舊 client ID、access token 與 refresh token 全部失效。

再次 run 後 Quick Tunnel 會換網址。先查看新的 status URL，再於 ChatGPT 以新 URL 重建開發者連線，重新完成 OAuth 與 Refresh。若保留舊 app，將名稱加上「已停止／舊連線」等明確標記，避免新聊天選錯；修改顯示名稱或保留舊工具清單並不會恢復連線。這個重新掛載步驟是目前開發方案的限制，不能宣稱已完成「安裝一次後固定入口免管理」的日常體驗。

本產品不建立開機常駐服務，不要求使用者建立 API Key，也不更換既有登入或新增 API 模型支出。固定網址與完全自動重連仍待符合使用者成本與權限限制的方案驗證。

## 日常交辦與平台限制

本機 AutoDev 與遠端連線完成後，可在一般 ChatGPT 直接交辦，例如「請在 demo 修正空值驗證，保留既有介面，執行相關測試並審查結果」。ChatGPT 選取登記的 `project_id`、提交明確需求與驗收條件，保存 job ID，查詢執行狀態並讀取證據。本輪已由真正一般 ChatGPT 交辦隔離專案並讀取完整證據；各層驗收結果見 [驗收紀錄](VALIDATION-2026-09-05.md)，固定日常入口仍待完成。

電腦重開機後先用本機 start／doctor 接續 AutoDev，再啟動開發連線、取得新 URL 並重新掛載 ChatGPT。既有任務不必重送；以 job ID 查詢和接續。若舊聊天呼叫新外掛仍回帳號連線錯誤，從新外掛詳細頁按「在聊天中試用」，選「對話」，以正確的新外掛標籤建立聊天，先唯讀核對原 job，再重新讀完整證據。此次實测可用這個流程恢復，不能只靠在舊聊天文字中改寫外掛名稱。每次換 URL 的手動重新掛載，是目前尚未滿足固定日常入口的限制。

服務會保留已完成執行但尚未審查的任務。原聊天回覆結束後自動醒來續審、iOS 的工具支援，都不能由本服務保證。聊天停止時，可在同一或新的已連線聊天說「繼續審查 AutoDev 的 job ……」，重新取得目前證據。不得把 Codex 的完成訊息當成 ChatGPT 已審查通過。

```powershell
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 status
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 stop
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 restart
```

`stop` 是明確停止目前本機任務／服務的動作。它先驗證程序的 PID、建立時間、執行檔、工作區命令與 instance，嘗試 graceful shutdown，必要時只停止符合紀錄的程序樹。找不到程序時處理 stale process record；身分不符或停止失敗時保留證據，不誤殺其他服務。

## 回答問題與核准

ChatGPT 可透過 `autodev_answer` 回送使用者的產品答案；它沒有可自我核准提權的 MCP 工具。若本機出現執行核准，先看 `status` 的確切操作、job/turn/request ID 與有效期限，再在本機明確接受、拒絕或取消：

```powershell
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 approve -JobId '實際job-id' -TurnId '實際turn-id' -RequestId '12' -RequestIdType number -Decision accept
```

`request_id` 的型別必須保持原樣：JSON 數字用 `-RequestIdType number`，JSON 字串用 `string`。字串 `"12"` 與數字 `12` 是不同請求。過期、跨任務或重複核准會被拒絕；重新查狀態，不繞過檢查。若回應途中斷線，先查狀態，別假設第一次沒生效。

也可用本機 `answer` 回答產品問題。自行建立答案 JSON，例如 `{ "format": { "answers": ["CSV"] } }`，再用同一組 job/turn/request ID 和 `-AnswersFile` 傳入：

```powershell
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 answer -JobId '實際job-id' -TurnId '實際turn-id' -RequestId 'q1' -RequestIdType string -AnswersFile '.\answers.json'
```

答案是明確產品選擇，不能代替權限核准。答案檔如含私人內容，使用後留在自己的私密位置，不提交到產品儲存庫。

## 更新與回復

0.4.1 的 `update` 會在停止狀態下先製作、驗證私密 runtime 備份。可另用 `backup`、`verify-backup -BackupId ID`、`restore -BackupId ID`；restore 保留當前原目錄並要求重建 source 後才能 start。失敗 setup/update 會留下 `build-incomplete.json` 以拒絕啟動半成品。完整規則見 [本版備份與 rollback](SECURE-TUNNEL.md#更新備份與-rollback)。

`update` 更新的是**目前已選取的本機程式版本**：安裝 lockfile、型別檢查、測試、建置，不 fetch、pull、merge、push 或更換分支。先記下 `git rev-parse HEAD` 與 `git status --short`，保存未提交變更；確認任務完成或明確取消後停止通道及 AutoDev，也先結束這個 checkout 的測試與開發程序，避免 Windows 鎖住 `node_modules` 內的工具。由使用者或獲授權的開發流程選取已檢查的新 commit，再執行：

```powershell
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 update
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 start
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 doctor
```

setup/update 偵測到紀錄中的程序仍在或設定埠被占用，就在修改 dependencies／build 前拒絕。更新保留 `.runtime` 的設定、token、任務與證據；不自動重啟。任何檢查失敗都回傳非零且停止。若 npm ci 回報檔案占用，先等待本 checkout 的測試結束，再重試原命令，不提升權限或任意停止其他 Node 程序。其他失敗先修復，或在保存目前變更後選回已知可用 commit，再重跑 update。未來若 state schema 改版，需先停服並做私密備份、核對相容性；不可用舊程式直接覆寫未知 schema。

強制重開機後先 `status` 和 `doctor`，再 `start`。伺服器會接續檢查既有任務，無法確定前一操作結果時保留 recovery 狀態。不要刪除任務 state、lock 或 evidence 以強迫重送；查明原 job/thread/turn 的結果後再決定接續。程序尚存在或身分不符時，不手動清理其紀錄。
