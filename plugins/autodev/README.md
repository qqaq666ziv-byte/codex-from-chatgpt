# AutoDev 工作流程技能

這是可攜式 planner/reviewer 技能套件，包含 `.codex-plugin/plugin.json` 與 `skills/autodev-workflow/SKILL.md`。它配合另行掛載的 AutoDev MCP 使用，沒有嵌入端點或憑證。

專案建立後的日常流程見 `docs/DEVELOPMENT-LOOP.md`；固定入口見 `docs/FIXED-ENTRY.md`。目前沿用已連接的 AutoDev App，一般 ChatGPT 依即時模型清單選擇 model/effort，交由 Codex 執行，再自行讀完全部版本化證據、審查與交回修正。Quick 備援與未啟用的 Secure Tunnel 候選不取代目前連接。安裝本技能不代表任何連線或 E2E 已通過；它也不是日常循環的必要安裝，MCP 本身已提供工作流指引。

先完成 MCP 掛載，再依目前帳號支援的本機 plugin／skill 匯入方式加入本資料夾。若介面只提供 MCP 連線，可以先使用伺服器工具說明；技能不是掛載成功的證明。啟動 HTTPS 或完成本機測試也不代表真正 ChatGPT 已完成唯讀、寫入與審查驗收。

安裝此套件不會建立 ChatGPT 連線、啟動背景工作、修改專案 allowlist 或授予新的執行權限。在 Codex 中載入技能也不代表一般 ChatGPT 已完成審查。套件不建立或修改使用者的 marketplace 設定。
