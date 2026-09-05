# 架構與恢復規則

ChatGPT 的 MCP 工具經官方 Tunnel、stdio proxy、經認證的 loopback HTTP 服務進入 AutoDev；AutoDev 使用官方 Codex App Server 的 thread/turn 執行介面。沒有另外計費的 API 規劃者，也沒有自製聊天介面。

## 儲存與身分

`jobs.json` 是 executor 索引；`product-state.json` 保存需求及每輪證據／審查對應；`requests.json` 保存操作雜湊與結果；`evidence` 儲存不可覆寫的版本化 snapshot。它們都位於設定檔同一 private runtime 下。程序需要持有 OS writer lease，所有上層異動序列化。寫入先完成暫存內容、fsync，再原子替換；checksum/schema 不符時拒絕啟動。fsync 與原子替換仍依底層 OS、磁碟及檔案系統保證，不能據此宣稱已測試真實斷电容錯。

同一 request key 只代表一個邏輯操作；成功重試回傳原結果，不另執行。若重啟時操作仍 pending，就標成 uncertain，不猜測副作用是否發生。持久產品 job ID、executor thread/turn 及要求版本保留，用來查明原結果。網路逾時不能換新 key 再試。

證據封存綁定 job、thread、turn、revision、完整 execution hash 與 source hash。ChatGPT 逐頁讀取的收據屬於該 MCP session；尚未提交審查時換 session，需要重讀。已成功持久化的 review 可用相同 request key/body 在重連後取得相同結果。

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
