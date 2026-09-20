# Scoped review 暫停交接 — 2026-09-20

> 下列暫停狀態保留作為歷史紀錄。接續後的最終型別檢查、54 項 focused tests 和 build 均已通過；安裝與正式 MCP 結果見本 PR 的交付紀錄。

依使用者要求先停在可恢復段落。本修改尚未安裝到正在使用的 AutoDev，原服務保持運行，沒有重啟或 OAuth 變更。

## 已保存

- 工作分支：`codex/review-scope`。
- 修改前遠端來源還原點：`checkpoint/20260920-before-review-scope`，SHA `bd3cfd502c60e154e2f58fe8f07accd6f051ff7c`。
- 此 checkpoint 保存原 AutoDev 當時已有的 73 個修改／新增來源檔，不把這些既有工作算作本次已審核變更。原 checkout 的 index 和來源檔未修改。
- 原服務路徑：`product/autodev`；隔離修改路徑：`product/autodev-review-scope`。PR 以獨立 checkpoint 分支為基準，使本次 diff 保持聚焦。

## 驗證的實際狀態

- `npm.cmd run typecheck` 與 `node --import tsx --test test/review-scope.test.ts test/snapshot.test.ts test/product.test.ts`：初版 35/35 通過、退出碼 0。
- 之後補強 scope 理由的 token redaction、明確 glob 測試值、skill/文件；暫停前未重跑最終版 focused tests，不宣稱最終版完整通過。
- `npm.cmd run check`：型別階段通過，測試階段由使用者要求暫停。只停止當次已核對父子關係、命令和建立時間的 14 個 test 程序。全套未完成，沒有 build 或全套 PASS 聲明。
- 接續後執行 `npm.cmd run typecheck`、`node --import tsx --test test/review-scope.test.ts test/snapshot.test.ts test/product.test.ts test/planner-input.test.ts test/routing-integration.test.ts`、`npm.cmd run build`，全部 exit 0，54/54 tests 通過。範圍涵蓋新 scope 判斷、snapshot、產品審查、header 與 routing 整合；未重跑不受影響的 Windows launcher 完整測試。唯讀獨立程式審查未發現確證阻擋。
- 本機輸出保存於隔離 worktree 的 `.local-tests/review-scope-check.log`，程序停止清單是 `.local-tests/review-scope-stopped-processes.json`；均 ignored，不上傳私密 runtime 或原始輸出。
- 固定 lockfile 的 `npm ci --ignore-scripts` 成功。`npm audit` 發現既有 4 項公告（fast-uri high；hono、qs moderate；diff low），本次未更新依賴。不要將此敘述當成新增漏洞或 0 漏洞聲明。

## 繼續時

1. 先確認這個分支及原服務 checkout 的 Git 狀態。閱讀 `docs/REVIEW-SCOPE.md`，執行最終版型別、上述 focused tests 及 build；按受影響範圍決定是否仍需其他檢查，不以整個產品 E2E 作為排除既有 PNG 的必要條件。
2. 檢查 `bd3cfd5..HEAD` 只包含本次 scope/hash/測試與相應文件變更。把原服務所有 nonignored 來源的 SHA-256 清單及將修改檔案的原始 bytes 保存到私有安裝備份；逐檔確認原檔相對 checkpoint 沒有新變更，才同步本次實際變更，保留其他既有工作。
3. 在原服務 checkout build。使用現有 `scripts/manage-daily.ps1 -Action status` 驗證 authenticated state、無 active/recovery job，再透過既有 `-Action restart` 安全重啟。不要改 App/OAuth identity、註冊範圍或私密狀態。
4. 透過正式已連接的 AutoDev `autodev_projects` 讀回新版 `workflow_instructions`，確認包含受影響範圍和 `AutoDev-Review-Scope`。這是 runtime/正式 MCP smoke，不冒充一般 ChatGPT 獨立審查。
5. 比對非本次變更來源的安裝前後 hashes，記錄實際結果，再完成 PR/交付。舊 Expense Tracker manifest/PASS event 保持不變，不為製造歷史正式 PASS 重跑整套審查。

## Plugin 真正入口

沒有在 Codex 已安裝 skills/plugin cache 找到 `autodev-workflow` 副本。本機來源 skill 位於 `plugins/autodev/skills/autodev-workflow/SKILL.md`，portable plugin manifest 更新為 0.1.1。正在使用的 remote AutoDev 指引由 `src/workflow.ts` 經 MCP initialize 及 `autodev_projects.workflow_instructions` 提供；只有完成上述 build/restart 和正式工具讀回，才算 remote plugin 修正已載入。

## 還原

若尚未同步，原服務不需還原；保留隔離分支即可。若之後安裝失敗，先確認服務 idle，以同一安裝備份逐檔還原本次替換項目、重新 build，再使用既有 lifecycle 工具重啟；不要 reset 原 dirty checkout、刪除 checkpoint、重寫歷史或回復私密狀態檔。
