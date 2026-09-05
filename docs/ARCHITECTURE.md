# 架構與恢復規則

一般 ChatGPT 的 MCP 工具經 Quick Tunnel HTTPS、本機 OAuth gateway 與經認證的 loopback HTTP 服務進入 AutoDev；本機 MCP 客戶端也可使用 stdio proxy。AutoDev 使用官方 Codex App Server 的 thread/turn 執行介面。沒有另外計費的 API 規劃者，也沒有自製聊天介面。

0.4.1 在相同 OAuth gateway 前增加 Secure MCP Tunnel 候選 transport，仍受零新增費用關卡保護。它不更換 core 狀態機、不用 tunnel ID 當 reviewer identity；官方 transport 不能自行解決瀏覽器 OAuth 公開入口。完整決策及尚未驗收部分見 [SECURE-TUNNEL.md](SECURE-TUNNEL.md)。

## 儲存與身分

`jobs.json` 是 executor 索引；`product-state.json` 保存需求及每輪證據／審查對應；`requests.json` 保存操作雜湊與結果；`evidence` 儲存不可覆寫的版本化 snapshot。它們都位於設定檔同一 private runtime 下。程序需要持有 OS writer lease，所有上層異動序列化。寫入先完成暫存內容、fsync，再原子替換；checksum/schema 不符時拒絕啟動。fsync 與原子替換仍依底層 OS、磁碟及檔案系統保證，不能據此宣稱已測試真實斷电容錯。

同一 request key 只代表一個邏輯操作；成功重試回傳原結果，不另執行。若重啟時操作仍 pending，就標成 uncertain，不猜測副作用是否發生。持久產品 job ID、executor thread/turn 及要求版本保留，用來查明原結果。網路逾時不能換新 key 再試。

證據封存綁定 job、thread、turn、revision、完整 execution hash 與 source hash。直接連入本機的 MCP 客戶端使用有狀態 session，逐頁讀取收據屬於該 session；關閉、過期或更換 session 後，尚未提交的審查需要重讀。

受信任 gateway 使用每請求獨立的無狀態 HTTP MCP transport，讀取收據則歸屬於 **issuer 與 OAuth grant 組成的穩定審查身分**。同一 grant 的 token 輪替或不同 HTTP 請求不會拆散收據。gateway 以本機 admin token 衍生的 HMAC 金鑰簽署 assertion，綁定 issuer、grant、POST 方法、`/mcp` 路徑、原始 request body 雜湊、最長 60 秒有效期與單次 nonce。核心驗證簽章及重播紀錄後才接受該身分；公開請求提供的 assertion／簽章不會被 gateway 轉送，只有一般 client token 或 OAuth token 無法偽造此證明。

同一外掛連線可能讓多個一般 ChatGPT 對話共用 OAuth grant。伺服器強制檢查的是**已驗證 grant 對指定 manifest 的完整逐頁讀取**，無法用密碼學證明是某一個對話或模型親自完成審查。要確認「同一聊天完成讀取與審查」，仍須另外核對該聊天的 UI 與實際工具呼叫證據。

gateway 審查身分閒置 30 分鐘後清除讀取收據；核心服務重啟也清除全部記憶體收據。不同 grant、收據過期或核心重啟後，必須重新逐頁讀完同一 manifest 的所有 artifact。已成功持久化的 review 仍可用相同 request key/body 在重連後取得原結果。

review 在異動鎖內先驗證 manifest、完整讀取、來源與 execution／測試證據，再建立 journal pending。此階段的拒絕不新增 request 紀錄，可修正前提後重試同 key；缺少收據會回 `EVIDENCE_NOT_READ`。若 dispatch 前的再次驗證發現身分已失效等變化，會記為已確認無寫入的 failed；真正的持久化失敗仍保留 uncertain。既有 uncertain key 不會因程式更新而自動清除或重播，仍須查明原結果。

## 核准與問題

伺服器顯示 App Server 發出的原 request ID（區別數字與字串）、job/turn、內容及 15 分鐘有效期限。過期不會轉為同意；使用者可取消 turn 再重新交辦。產品問題只接受完整對應 question IDs 的答案。

MCP 不提供接受 command/file/network 提權的工具。本機管理者可對 command/file 做單次 accept/decline/cancel；目前不接受 session 級核准、execpolicy amendment 或泛用 permission profile 擴張。需要額外 profile 時保留明確阻礙，取消並調整任務或依官方介面處理，不自行放寬。

## 恢復

1. 客戶端斷線：重新連線，先查 `autodev_status`。已完成工作與待審證據仍保留。
2. AutoDev 正常停止：App Server 一併停止。再次啟動時檢查持久任務；對已知 thread 做 read/resume，只有確定同一 turn 才接續。
3. App Server 意外中斷：ready 降為 false，任務進 recovery；本機重啟執行器後再核對已知 thread。未核對前不派新工作。
4. 操作已送出但回覆未持久化：uncertain 不自動重送。先查看本機管理狀態與既有 job。無法確認原 turn 身分時，需要人工核對官方 Codex thread／實際工作目錄，不刪 journal 或伪造成功；此版本沒有通用的「強制解除不確定」按鈕。
5. state 損壞：停止服務，保留損壞檔及證據。從停止狀態下製作、驗證過的私人備份復原相同版本；沒有備份時先人工重建對應，不建立空白 state 冒稱無任務。
6. Windows 強制重開機：OS Mutex 釋放。CLI 仍核對 PID、建立時間、完整命令與 instance，避免 PID 重用導致誤殺。未驗證非 Windows 平台的自動 crash recovery，檔案鎖不自動接管 stale owner。

這個版本保留安全的待接續狀態，並不保證任何未知副作用都能完全自動恢复。正式資料的獨立備份與復原仍由該專案的交辦規則決定。
