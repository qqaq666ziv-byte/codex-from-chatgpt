# 來源與版本

AutoDev 0.4.1 從 joseanu/codex-from-chatgpt 0.3.1 延伸；本輪產品基準為已驗證的 `cc18c408f1431336f4ba673c4d26c81b68aa4f91`。

- 固定比較基線：`093bd39ea0770a80612a5184a85b82262759aa00`。
- 上游：https://github.com/joseanu/codex-from-chatgpt 。
- 本 fork：https://github.com/qqaq666ziv-byte/codex-from-chatgpt 。
- 開發分支：`codex/autodev-product`。
- 授權：保留根 `LICENSE` 的 MIT 原作者聲明。`docs/UPSTREAM-README.md` 保留原始說明；其 dogfooding 等敘述是上游歷史，不是本 fork 的測試證據。
- 0.4.0 歷史建置增加固定 `diff@8.0.2`；0.4.1 沿用現有 MCP SDK、Zod、TypeScript 等 lockfile 精確版本，沒有增加 npm 套件。
- 相容驗證使用 Codex CLI `0.153.3`。上游 `protocol/codex-0.147.0-ts` 是既有型別來源；實際模型、effort、帳號與關鍵 RPC 均向目前 App Server 驗證，不把型別資料夾名稱當成執行版本。
- 無 API Key 的開發 HTTPS 通道使用 Cloudflare 官方 `cloudflared 2026.8.2` Windows x64 release；SHA-256：`c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5`。安裝器下載固定版本並核對雜湊；二進位只在本機 ignored `.tools`，沒有再散布到此 fork。
- OpenAI 官方 [tunnel-client v0.0.14](https://github.com/openai/tunnel-client/releases/tag/v0.0.14)，source commit `0f870e50a973fa820d4c409000059e181e8d242b`。本輪將 runtime 認證 key 與模型 API 計費分開評估；已安裝並建立受成本關卡保護的候選介面，未使用真實 key 或連線 OpenAI control plane。
- Windows amd64 ZIP SHA-256：`784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5`；解壓後 `tunnel-client.exe` SHA-256：`fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b`。安裝保留官方 ZIP 內的 LICENSE／NOTICE／SBOM；binary 只在 ignored `.tools`。operator 查更新可從 [官方 latest release](https://github.com/openai/tunnel-client/releases/latest) 找到新版，但本產品不自動換未驗證版本。
- 圖示為本產品自行編寫的 SVG／PNG 幾何圖形，由 `scripts/build-icon.mjs` 確定性產生；沒有新增影像 API 或 npm dependency。0.4.1 lockfile 只更新產品版本號，套件版本不變。

產品的 commit 以此檔案所在 Git commit 為準：`git rev-parse HEAD`。私人 PoC、既有工作區歷史、對話、token 與 runtime 不屬於此 fork。
