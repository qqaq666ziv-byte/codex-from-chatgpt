# 從新專案意圖開始工作

一般 ChatGPT 收到明確的新軟體專案需求後，呼叫 `autodev_create_project({request_key, name})`，取得 `project_id`，隨即將原始需求與 acceptance 送到既有 `autodev_submit`。submit 使用另一個穩定 request key，並沿用既有 router、status、evidence、review、continue。使用者不用先建立資料夾或開啟 Codex。建立 workspace 不等於執行完成，也不等於 ChatGPT review 通過。

本機 config 的選用 `projectCreationRoot` 是管理者預先授權的唯一根目錄。本次授權為 `D:\QQ\02_網頁與程式開發`；工具沒有 path/root 參數，只能建立它的直接子目錄。未設定時安全拒絕。首次啟用或程式更新需要重啟核心；之後每次建立與註冊立即可見，不需要重啟。OAuth 和 ChatGPT 工具清單快取仍由既有連線流程處理。

`name` 是顯示名稱，採 NFKC 與前後空白正規化，最多 100 字元。folder 將 Windows 禁用的 `< > " | ? *` 換成 `_`、合併空白、移除尾端點與空白；保留中文。Windows 裝置保留名稱加 `_` 前綴。路徑分隔符、冒號、控制字元、`..` 與點開頭名稱直接拒絕。總路徑上限 240 字元。ID 優先使用可讀 ASCII 小寫名稱，必要時加入固定 hash，與顯示名稱分開。

新增 registry 與 request identity 原子寫入私密 runtime 的 `project-registry.json`，包含 checksum、根目錄與 workspace 的實體檔案 identity。啟動時與原 config.projects 合併，不重寫既有 registry entries、jobs、review 或 request journal。既有 runtime writer lease 保證單一核心寫入；建立操作同步完成，不跨 await，也不會與 shutdown 交錯。runtime 備份會包含此檔，但不會備份外部作品內容。

同 request_key 與 name 重送會回傳同一結果；改名重用 key 拒絕。同名且同位置的已註冊專案回傳現有 ID。不同名稱正規化至同一資料夾會 conflict。未註冊資料夾即使是空的也不接管。工具不執行 Git、framework、安裝或 scaffold。

建立前先持久記錄 intent，再建立資料夾並原子提交 registry。若提交失敗，只會以非遞迴 rmdir 嘗試移除本次建立、identity 未變且仍為空的資料夾；其他內容保留。若程序在 mkdir 與 registry commit 間中斷，下一次看見未完成 intent 加現存目錄會回報 `PROJECT_CREATION_UNCERTAIN`，需要本機查核，不會猜測接管或建立第二份。intent 對同一 folder 保留名稱，不能用新 key 繞過不確定狀態。

建立及使用 managed workspace 時檢查根目錄、所有祖先與目標是否仍為實體目錄，拒絕 symlink/junction、canonical path 或 identity 改變。管理者更換磁碟／搬移根目錄須另行查核，不能沿用舊 identity。這是對 MCP 輸入與既有檔案連結的邊界；不宣稱能隔離擁有本機管理權、可同時置換檔案系統的攻擊者。

新建且未 Git 初始化的 workspace 使用有上限的檔案快照：保留既有 secrets exclusion，跳過連結與常見依賴／產物目錄；最多 10,000 entries、64 層、2 MiB/file、32 MiB/project。尚未 Git 初始化時不解讀 `.gitignore`，敏感內容應放在明確排除的路徑。後續由 Codex 按需求初始化 Git 後，自動沿用原 Git 快照。舊註冊專案維持原 Git 根目錄檢查。

直接相關驗證：`D:\node.exe --import tsx --test test/create-project.test.ts test/snapshot.test.ts`。另有明確 opt-in 的 `scripts/create-project-real-smoke.ts`，用隔離 registry/jobs 與一次真實訂閱 Codex turn 證明 create → register → submit；它不是普通 ChatGPT OAuth/E2E，也不寫 review。
