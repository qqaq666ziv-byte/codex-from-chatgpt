# 2026-09-12 AutoDev 每日可用性修復

## 已確認的問題

- 正式 `autodev_projects` 回 `-32603 Internal error`。本機 core ready、5 個既有工作、沒有 active job，但 fixed/native 程序皆停止。
- 今天登入排程 08:11 執行，LastTaskResult=1。原設計只啟動一次；失敗或日後 tunnel 退出，重開 Codex 不會再觸發。未讀私人 runtime log，不宣稱已還原第一次退出的底層原因。
- 重跑原入口恢復 transport 後，正式 connector 與 ChatGPT 同一 AutoDev 管理頁仍要求重新授權。原 OAuth 最長 8 小時／64 次 refresh，隔夜失效已由實際 OAuth 與持久化程式路徑重現。

## 修正與實際啟用

- `availability.ps1` 在目前使用者背景執行，每 5 秒辨識官方 Codex desktop instance，新開啟時檢查；平常每 60 秒核對 core／固定入口。失敗按 30／60／120／240／300 秒退避，不堆疊程序、不派工或重播模型任務。
- 既有同名 Interactive／Limited 登入排程已更新並啟動，沒有密碼或最高權限；移除原執行時間限制，監督異常退出最多重試 3 次。專屬 mutex 防重入，啟動沿用 lifecycle lock 及 PID／建立時間／instance 身分檢查。
- 手動 Stop 保持至下次 Codex 開啟；停用／移除自啟後監督退出。保存的版本化 Codex exe 被更新移除時，只從持久 Machine＋User PATH 找已安裝的實體工具，不下載。
- 按使用者最新要求，新授權持續有效直到撤銷，沒有固定天數或一般 refresh 次數上限；access token 仍為 10 分鐘，自動更新。授權頁明示期限與原有交辦／證據／審查權限。
- OAuth schema 2 使用 `expiresAt: null`、每筆 grant 的隨機簽章金鑰與 refresh 世代。HMAC-SHA256 綁定 issuer／resource／client／scope／世代，能辨識並撤銷舊 token 重放，不累積無界的已用 token 清單。金鑰與 token 雜湊由 Windows CurrentUser DPAPI 加密，保留寫入失敗封鎖與 stale writer 防護。
- client／grant 各最多 32 筆，有效 access token 最多 4096 筆，持久資料最多 4 MiB；容量不足拒絕且不消耗現有 refresh，短效 access 到期後可恢復。計數器有安全整數溢位防護，不是日常到期政策。
- 舊 schema 1 保留原 8 小時／64 次限制，不能因升級自動延長或復活。新增僅經驗證的本機 admin 通道可使用的 `grants`／`revoke`；撤銷立即使該 grant 的全部 token 失效並跨重啟保留。
- 新版固定 gateway 已載入且 readiness 全部通過，背景監督 ready、連續失敗 0。原 core、allowlist 與 5 筆歷史工作保留；沒有 push／merge／deploy、依賴安裝、模型派工或付費 fallback。

## 驗證證據

| 命令／操作 | 實際結果 |
| --- | --- |
| `node --import tsx --test --test-name-pattern='one consent survives years' test/oauth-state.test.ts`，修正前 | 1 fail、exit 1，固定天數到期後 refresh invalid_grant |
| `node --import tsx --test test/oauth.test.ts test/oauth-state.test.ts`，核心修正後 | 29 pass、exit 0；8,200 次逐日 refresh、22 年以上模擬時間、多次重建後保持同一 grant、state 小於 4 KB；最早 refresh 重放仍撤銷整組 |
| 追加 local revoke／偽造／容量／schema corruption focused checks | 通過；明確撤銷跨重啟保留，另一筆授權保持可用；容量錯誤不消耗現有 refresh |
| `node --import tsx --test test/gateway.test.ts test/relay-gateway.test.ts` | 12 pass、exit 0，含 authenticated-local-only 撤銷 HTTP 行為 |
| Windows 授權管理入口 | PowerShell 5.1 與 7 行為測試通過，保留參數且失敗不回報成功 |
| `npm.cmd run check` 最終完整驗證 | exit 0；core 303 項：301 pass／0 fail／2 conditional skip；Worker 29 pass／0 fail；typecheck/build 通過 |
| 原同名登入排程真啟動 | Running；PT0S；RestartCount=3、PT1M；監督身分核對與 ready 通過 |
| 停止本輪 fixed connection，等待背景自行恢復 | 新 PID／instance，完整 readiness true、active job null、task count 5，core 保留 |
| 來源保留 | 907 個既有檔案中，僅 14 個預期修改；其餘 893 個 SHA-256 不變；新增 5 個產品檔案 |

一次緊接恢復的外部 readiness 未確認；後續身分與完整 readiness 再讀確認成功，不宣稱網路永不波動。去敏測試證據、原檔備份與 baseline 在 ignored `.local-tests/availability-20260912`；本輪專屬 patch 為工作區 `.ai-bridge/availability-20260912.patch`，保留原歷史 implementation diff。

## 主動撤銷

詳見 [ChatGPT App 操作文件](CHATGPT-APP.md#主動撤銷長期授權)。在產品目錄執行：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/fixed-tunnel.ps1 -Action grants
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/fixed-tunnel.ps1 -Action revoke -GrantId "<選定的 grant_id>"
```

不假設 ChatGPT「中斷連線」一定會通知本機撤銷；需要確認伺服器授權已失效時使用本機 revoke。

## 正式連線驗收與限制

依使用者最新明確要求，已為同一正式 AutoDev App 完成一次新核准。ChatGPT 管理頁已回復連結狀態，本機管理 API 確認唯一 ChatGPT grant 的 expires_at=null。直接從 Codex 呼叫正式 `autodev_projects` 成功取得 1 個已註冊專案，`autodev_status` 成功讀回原有 5 筆工作；兩個工具都沒有 error。未提交或重播任務。

永久授權完成後，再次正常停止本輪 fixed gateway，未手動 start；既有背景監督自行恢復至完整 readiness。2026-09-12T06:03:51Z 核對同一 grant 保留、expires_at=null，正式 `autodev_status` 再次成功，5 筆工作 execution/review 狀態全部一致，沒有再次授權。去敏結果在 `.local-tests/availability-20260912/permanent-recovery-result.json`。

使用者針對先前的 30 天核准問題，明確改要求永久授權；本次依該要求透過產品既有本機管理指令核准同一 App 的新請求。原有 scope、專案 registry 與平台動作同意設定保持原值。

未為驗證關閉使用中的 Codex、登出或重開機；完整關閉再開啟 Codex／Windows 重新登入尚未實測。永久授權代表 AutoDev 不再以固定期限要求重連；平台仍可能因帳戶登出、撤銷或政策改變要求重新登入。電腦離線、休眠或平台限額也可能暫時影響可用性。

## 本輪產品變更檔案

- 啟動：`scripts/availability.ps1`、`scripts/autostart.ps1`、`scripts/manage-daily.ps1`。
- 授權：`src/oauth-policy.ts`、`src/oauth.ts`、`src/oauth-state.ts`、`src/gateway.ts`、`src/fixed-tunnel-runner.ts`、`scripts/fixed-tunnel.ps1`。
- 回歸測試：`test/availability-windows.test.ts`、`test/autostart-windows.test.ts`、`test/authorization-management-windows.test.ts`、`test/oauth.test.ts`、`test/oauth-state.test.ts`、`test/gateway.test.ts`。
- 文件：`docs/AUTOSTART-WINDOWS.md`、`docs/CHATGPT-APP.md`、`docs/FIXED-ENTRY.md`、本報告。
