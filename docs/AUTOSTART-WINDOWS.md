# Windows 日常操作與登入自啟

## 2026-09-12 更新：Codex 開啟與連線恢復

登入動作現在保留一個目前使用者的背景可用性檢查程序。每 5 秒辨識同一 Windows session 中的官方 Codex 桌面程式（目前套件內為 `ChatGPT.exe`），開啟新的 Codex instance 時立即檢查；平常每 60 秒核對 core 與固定入口。登入先等待 30 秒讓網路準備，之後失敗按 30／60／120／240／300 秒退避，最多每 5 分鐘再次嘗試。每次等待從該次失敗結束計算；沿用同一個啟動入口，不部署、不提交模型任務或重播工作。

排程不再有原本 20 分鐘上限；監督程序意外退出時由排程最多重試 3 次、間隔 1 分鐘。工作排程 IgnoreNew 與專屬 mutex 防止重複監督，服務仍使用既有 lifecycle lock、PID／建立時間／instance 核對。`autostart.ps1 status` 的 `availability` 回報程序身分核對結果、最近檢查、下一次檢查與重試次數；不讀取或顯示原始 runtime log。

手動 Stop 在本次 Codex 開啟期間持續有效；關閉後重新開啟 Codex 才重新啟用自動恢復。停用／移除自啟後，監督程序在下一次迴圈退出；如正在啟動則等待該次有界啟動結束，之後不再重試。網路／平台／授權失效仍可能暫時不可用，`ready` 是連線證據，實際外掛呼叫另外驗證。

以下登入設定與停用介面繼續適用。既有安裝執行一次 `autostart.ps1 -Action enable` 更新同名排程後，啟動該排程即生效。無須更換 Codex 捷徑。

這些入口只操作既有 AutoDev core 與固定連線，沿用相同固定 App、OAuth 持久資料、project registry 與任務證據。它們不啟動歷史 CodexPro handoff watcher，不提交或重播工作。

在 `product/autodev` 使用：

| 入口 | 行為 |
| --- | --- |
| `Start-AutoDev.cmd` | 既有前置檢查 → core → 固定 gateway／cloudflared → 本次 instance readiness。 |
| `Status-AutoDev.cmd` | 核對 core PID、建立時間、instance 與 admin 身分，再列出固定連線的準備狀態。 |
| `Stop-AutoDev.cmd` | 確認無 active／recovery-required／dispatch-uncertain 執行後，先停止固定入口，再停止 core。 |
| `Restart-AutoDev.cmd` | 同一 lifecycle lock 內安全停止，再呼叫相同的日常啟動邏輯。 |

各 `.cmd` 都接受 `--no-pause`，適合指令列使用。`scripts/manage-daily.ps1 -Action start|status|stop|restart` 是相同控制介面。core 與各 transport 的低階腳本保留供診斷；日常整組操作使用上表入口。

`ready_for_chatgpt_probe: true` 表示本次固定入口可進入 ChatGPT 驗收；不等同一般 ChatGPT 已成功呼叫工具。`startup_probe`／`blocked` 是去敏診斷；不輸出 runtime token、完整授權 URL 或任務內容。

## 啟用、停用與移除

在產品目錄執行；下例的 execution policy 參數只套用這個腳本程序，不改使用者或整機政策，也不覆寫 Group Policy：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\autostart.ps1 -Action enable
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\autostart.ps1 -Action status
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\autostart.ps1 -Action disable
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\autostart.ps1 -Action enable
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\autostart.ps1 -Action remove
```

`enable` 優先建立目前使用者的 `AutoDev-Login-<工作區及 SID 雜湊>` 工作排程：Interactive 登入、Limited 權限、不保存密碼、不要求最高權限。Windows 登入觸發動作後，動作自身等待 30 秒，再使用同一 `manage-daily`／`start-daily` 邏輯。排程設定 IgnoreNew，且 launcher 自身另有跨程序 mutex；啟动器結束後，背景服務也由既有 PID、建立時間、instance 與 runtime lease 防止重複。

如果排程建立被存取權限拒絕，使用已授權的同使用者 Startup 資料夾替代：只建立一個帶工作區身分的 `.vbs`，隱藏啟動同一個 `autostart.ps1 run`。其他錯誤不當成權限拒絕，也不以 fallback 掩蓋。既有同名排程與 Startup 檔案都先核對 owner／action 或完整預期內容，衝突時保留原檔。

`.runtime/autostart.json` 保存工作區／SID、機制、是否啟用、絕對 Node／Codex 路徑；不保存密碼、模型 API key 或 OAuth token。登入啟動會重新載入持久 Machine＋User PATH，並驗證已保存的 Node `.exe` 與 Codex `.exe`／`.cmd`，不依賴先前終端的暫時 PATH，也不會選取 `codex.ps1`。執行檔搬移或更新後可重新 `enable`，使用已安裝工具刷新絕對路徑。

`disable` 保留設定供 `enable` 恢復；`remove` 移除本功能擁有的排程／Startup 項目與設定。兩者讓可用性監督程序退出，保留已運行的 core／固定入口；要同時停止服務使用 `Stop-AutoDev.cmd`。正在等待或啟動的動作會重新核對 enabled 與手動 stop 世代。服務失敗以有上限的頻率重試，成本／設定／身分驗證仍須通過。

## 失敗、恢復與驗證範圍

- 同時發生 start／stop／restart／自啟控制時，共用工作區的 `Global\AutoDev-Daily-*` mutex；競爭者退出並回報，不另啟一套服務。
- 執行中、等待 approval、interrupting、recovery_required 或 dispatch_uncertain 的工作阻止 stop／restart。歷史 review journal 的 uncertain 記錄保留，但不把已完成工作的 review 不確定性誤認為 active execution。
- router 在初次提交就拒絕、明確標示 `dispatch_status: not_dispatched` 並核對無 thread／turn／selected model／effort 的 blocked 工作可以停止；欠缺這些證據或已有執行 identity 的 blocked 狀態仍拒絕。後續回合被 router 拒絕時，依保留的前一回合 execution status 判斷。
- core 停止前會再次驗證 active execution；拒絕或認證失敗不當成可強制停止的依據。程序建立時間不同代表 PID 已重用，仍須確認設定 port 沒有其他 listener。
- 每次啟動的網路等待由既有固定入口 readiness 流程限時執行；失敗後由可用性監督退避重試，沿用相同啟動入口，不重送任務或更換模型。
- 停用／移除自啟後可繼續使用同一手動入口；OAuth、jobs、review 與 immutable evidence 都保留。不要為修復啟動而清空 `.runtime` 或重建 registry。
- 關機、睡眠或登出使服務不能接單；此功能不是雲端常駐服務。閒置期間不提交模型推理。

隔離行為測試：`node_modules\.bin\tsx.cmd --test test/autostart-windows.test.ts`，在 Windows PowerShell 5.1 與可用的 PowerShell 7 覆蓋 lifecycle identity、active／uncertain fence、重入／競爭、exit code、排程定義、權限拒絕 fallback、停用／恢复／移除、Startup 衝突保護、延遲時 stop／disable 與持久 PATH。測試只使用 `.local-tests` 和模擬排程 API，不註冊真排程、不啟動真服務。

真正排程／Startup 啟用、手動服務重啟與閒置資源量測以本輪交付報告為準。未實際重新登入或重開機前，`reboot_or_relogin_verified` 持續為 false；不為驗證而自動登出或重開機。
