# 受影響功能審查

預設審查使用者要求的變更、受影響行為及相關相依項目。完整來源是審查上下文，不代表每次工作都要審查全專案、所有既有圖片或重跑完整 E2E。只有明確要求、具體重大問題或未解的跨功能風險才擴大驗證。

## 固定範圍與證據

ChatGPT planner 自行辨識 Git 基準與相關依賴，不讓使用者逐張挑選圖示。若無關的既有 binary 資產需要排除，在 requirements 的開頭控制區塊加入一行：

```text
AutoDev-Review-Scope: {"mode":"changes","base_commit":"<完整基準 commit SHA>","excluded_binary_assets":[{"path":"public/icon.png","reason":"Existing unchanged application icon unrelated to this accounting change."}],"required_binary_paths":[]}
```

若同時使用 `AutoDev-Routing`，routing 必須是第一行，scope 緊接下一行，之後才放任務文字。這支援已凍結的 ChatGPT tool schema。每個新回合重新明確宣告；若還不知道基準，先讓 executor 建立可信基準資訊，再以 bounded follow-up 審查受影響範圍。這不需要新增產品功能或全專案 E2E。

- `base_commit` 必須是當前 HEAD 祖先中的完整、既有 commit SHA，不能用可移動分支名稱。
- `excluded_binary_assets` 是精確路徑及具體無關理由。服務在 dispatch 前比對基準 Git blob、當前 binary SHA-256 和長度，將證明保存到 round 和不可變 `review-scope.json`。
- `required_binary_paths` 列出與變更相關的 binary 依賴，不能同時排除。這類檔案仍需要適當的獨立證據，目前文字 artifact 管道不能自行記完整通過。
- 新增、改動、刪除、無 hash、非 UTF-8、redacted 或非 regular 檔案不能利用這個規則排除。敏感路徑仍先排除，不讀取或新增其內容 hash。
- 每次讀取與 pass 前後仍綁定完整來源 fingerprint（包括 binary hash/長度）、執行證據、manifest 與 authenticated reader 收據。排除的圖片之後改動，也會使 pass 變成 `stale_review`。

reviewer 必須實際閱讀 `review-scope.json` 與其他 artifact 所有分頁，判斷「無關」理由是否成立。檔案未修改不等於與功能無關，程式不能代替 reviewer 判斷視覺或語意依賴。

## 完整範圍与舊證據

明確完整審查可宣告 `AutoDev-Review-Scope: {"mode":"full"}`。缺少可信 scope 的舊回合沿用嚴格遺漏檢查，不能事後推測其 binary hash。舊 manifest、收據、review event 不會重寫。新版本功能只能用新回合、新 manifest 取得新 verdict；不得宣稱原本被拒絕的 PASS 已經正式寫入。

## 驗證界線

本變更以針對性測試驗證未修改 binary 排除、修改／新增／刪除仍阻擋、證據擷取後改動失效、重啟保存範圍，以及 secrets、UTF-8、完整分頁與 passing-check guard 保留。Mock 測試、實際 MCP 呼叫與一般 ChatGPT 審查三者必須分開報告。服務安全重啟後才能載入修正，單純 build 不算 runtime 已更新。
