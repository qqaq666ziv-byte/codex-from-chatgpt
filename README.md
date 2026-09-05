# AutoDev

讓一般 ChatGPT Chat 規劃與審查，由本機 Codex 修改程式、執行測試，並保留可逐頁查核的證據。

目前版本 **0.4.0**。本機橋樑已實作並進行真實 Codex 驗證；**真正 ChatGPT 的 HTTPS／OAuth 掛載與審查仍待實測，整個產品尚未宣告驗收完成**。安裝技能不等於建立連線。

從 [joseanu/codex-from-chatgpt](https://github.com/joseanu/codex-from-chatgpt/tree/093bd39ea0770a80612a5184a85b82262759aa00) 的 0.3.1 延伸，保留 MIT 授權及來源歷史。這是社群產品，並非 OpenAI 官方產品。

## 開始使用

需要 Windows、Node.js 20+、npm、Git、PowerShell 7，以及已透過官方 ChatGPT 登入的 Codex CLI。從此儲存庫根目錄執行：

```powershell
codex login status
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 setup
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 add-project -ProjectId demo -ProjectName '示範專案' -ProjectPath 'D:\Projects\demo'
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 start
pwsh.exe -NoProfile -File .\scripts\autodev.ps1 doctor
```

ProjectPath 請換成你授權的既有 Git 儲存庫根目錄。預設使用可用的 `gpt-6-astra`／`xhigh`，每次啟動和續辦均檢查實際設定，不會因不可用而改走 API 計費。日常交辦前，依 [Windows 安裝與連線指南](docs/INSTALL-WINDOWS.md) 完成不需要 API Key 的免費 HTTPS 開發通道、OAuth 和 ChatGPT 外掛掛載。

連線後可在加入 AutoDev 的一般聊天說：

> 請用 AutoDev 列出專案，對 demo 修正這個問題：……。先整理需求與驗收條件，再交給 Codex；完成後讀完原始條件、完整 diff 與測試證據，親自審查，有實際缺陷才要求修復。

## 已實作的流程

- `project_id` 對應本機管理者註冊的 canonical Git 目錄；MCP 不能新增路徑。
- request key 與內容雜湊先持久化。同鍵同內容重播；同鍵不同內容拒絕；不確定結果不自動重跑。
- 一個 runtime 同時執行一個 Codex turn。Windows 使用 OS Global Mutex 防止多個程序同時寫 state。
- 每輪保留條件、實際原始碼差異、App Server 命令／測試輸出與檔案雜湊。版本化 manifest 與 cursor 可以讀取完整證據。
- execution 與 review 狀態分開。ChatGPT 必須逐頁讀完同版證據才能記錄審查；源碼或執行證據已變更時，舊審查不能當作目前通過。
- 產品問題可以透過 ChatGPT 回答。權限核准只走本機 admin；MCP 規劃者不能自行接受提權。
- 已知任務可查狀態、取消、重連和續辦；續辦先恢復相同 thread，再核對模型與 effort。未知結果保留待處理狀態。

## 工具

| MCP 工具 | 用途 |
| --- | --- |
| `autodev_projects` | 列出已註冊專案與模型設定 |
| `autodev_submit` | 提交有 request key 的需求與驗收條件 |
| `autodev_status` | 查任務、執行及審查狀態 |
| `autodev_evidence` / `autodev_artifact` | 取得 manifest 與全部證據分頁 |
| `autodev_review` | 記錄對應證據版本的審查 |
| `autodev_continue` | 同一 thread 續辦或修復 |
| `autodev_cancel` | 取消指定的目前 turn |
| `autodev_answer` | 回覆原產品問題 |

## 邊界與尚未驗證項目

一般 ChatGPT 掛載、已授權寫入和親自審查需要實際平台驗收。免費 Quick Tunnel 僅供開發測試，重啟網址改變且 OAuth 授權失效，需重新掛載；固定日常入口尚未完成。iOS，以及聊天回覆結束後自動喚醒原聊天，尚未證實；本服務不宣稱能在背景強迫 ChatGPT 繼續。重新進入聊天時可查既有 job 接續。

橋樑記錄 authenticated MCP session 與完整讀取紀錄，不提供「某個特定模型已閱讀」的密碼學證明。測試辨識是命令與結束碼證據，仍需審查實際內容；Codex 自述成功不能代替審查。

目前完整原始碼證據限於 Git 追蹤或未忽略的 UTF-8 一般檔案，每檔 2 MiB、每專案 32 MiB。認證／私密檔名排除並列明；二進位、非 UTF-8、link 或 token 遮蔽造成內容不完整時，不會宣告完整審查通過。regex 遮蔽只是補充，不能保證偵測所有秘密。專案註冊控制交辦與證據路徑；實際命令仍受 Codex 的平台 sandbox／核准政策約束，不能將 registry 說成額外的 OS 讀取隔離。

`.runtime`、`.local-tests`、`.tools` 不提交；Windows runtime 使用私人 ACL。更新時先停止任務、通道及服務，再選取已檢查的版本。恢復方法見 [安裝指南](docs/INSTALL-WINDOWS.md) 與 [架構及恢復規則](docs/ARCHITECTURE.md)。

## 驗證與來源

```powershell
npm.cmd run check
# 以下使用目前 ChatGPT Codex 額度執行真實隔離任務：
npm.cmd run test:real
```

[本輪驗收紀錄](docs/VALIDATION-2026-09-05.md) 區分合成測試、真實 Codex 與尚未完成的 ChatGPT 驗收。[來源與版本](docs/SOURCE.md) 保留上游比較基線；[上游原 README](docs/UPSTREAM-README.md) 僅作來源歷史，不能當成本 fork 的驗收結果。
