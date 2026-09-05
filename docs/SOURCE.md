# 來源與版本

AutoDev 0.4.0 從 joseanu/codex-from-chatgpt 0.3.1 延伸。

- 固定比較基線：`093bd39ea0770a80612a5184a85b82262759aa00`。
- 上游：https://github.com/joseanu/codex-from-chatgpt 。
- 本 fork：https://github.com/qqaq666ziv-byte/codex-from-chatgpt 。
- 開發分支：`codex/autodev-product`。
- 授權：保留根 `LICENSE` 的 MIT 原作者聲明。`docs/UPSTREAM-README.md` 保留原始說明；其 dogfooding 等敘述是上游歷史，不是本 fork 的測試證據。
- 本輪增加固定 `diff@8.0.2`；既有 MCP SDK、Zod、TypeScript 等沿用上游 lockfile 精確版本。
- 相容驗證使用 Codex CLI `0.153.3`。上游 `protocol/codex-0.147.0-ts` 是既有型別來源；實際模型、effort、帳號與關鍵 RPC 均向目前 App Server 驗證，不把型別資料夾名稱當成執行版本。
- 無 API Key 的開發 HTTPS 通道使用 Cloudflare 官方 `cloudflared 2026.8.2` Windows x64 release；SHA-256：`c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5`。安裝器下載固定版本並核對雜湊；二進位只在本機 ignored `.tools`，沒有再散布到此 fork。
- 曾檢查 OpenAI Secure MCP Tunnel `v0.0.14`，但其 runtime API Key 要求不符合本輪使用者限制，因此不採用、不配置或執行該路線。

產品的 commit 以此檔案所在 Git commit 為準：`git rev-parse HEAD`。私人 PoC、既有工作區歷史、對話、token 與 runtime 不屬於此 fork。
