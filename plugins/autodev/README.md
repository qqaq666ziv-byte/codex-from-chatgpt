# AutoDev 工作流程技能

這是可攜式 planner/reviewer 技能套件，包含 `.codex-plugin/plugin.json` 與 `skills/autodev-workflow/SKILL.md`。它配合另行掛載的 AutoDev MCP 使用，沒有嵌入端點或憑證。

ChatGPT 的實際連線與驗證步驟見產品儲存庫的 `docs/INSTALL-WINDOWS.md`。目前開發方案使用免費 Quick Tunnel HTTPS 與本機 OAuth gateway，無需 OpenAI API Key；OAuth 連線由使用者比對瀏覽器驗證碼並在本機核准。這與 Codex 任務的執行權限核准是兩件事。Quick Tunnel 重啟後 URL 改變，需重新掛載，因此尚不是固定日常入口。

先完成 MCP 掛載，再依目前帳號支援的本機 plugin／skill 匯入方式加入本資料夾。若介面只提供 MCP 連線，可以先使用伺服器工具說明；技能不是掛載成功的證明。啟動 HTTPS 或完成本機測試也不代表真正 ChatGPT 已完成唯讀、寫入與審查驗收。

安裝此套件不會建立 ChatGPT 連線、啟動背景工作、修改專案 allowlist 或授予新的執行權限。在 Codex 中載入技能也不代表一般 ChatGPT 已完成審查。套件不建立或修改使用者的 marketplace 設定。
