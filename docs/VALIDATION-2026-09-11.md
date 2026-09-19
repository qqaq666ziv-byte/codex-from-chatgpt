# 2026-09-11 開發循環實際驗證

本輪保留既有資料、固定 AutoDev App 與 OAuth，沒有新增費用、依賴、遠端推送、合併或部署。以下將真實訂閱執行、一般 ChatGPT 審查、本機回歸測試分開記錄；舊日期報告不能取代本輪結果。

## 採用方案

沿用有效的 AutoDev 固定入口、持久任務、App Server 執行器與證據儲存，移除任務分級／模型品質分數的派工決策。一般 ChatGPT 讀取即時官方 catalog，自主選 model/effort 並負責獨立審查；本機只驗證選擇、套用設定、執行與封存證據。MCP 回傳包含完整循環指引，不需額外分類 API 或本機 reviewer。

新增 source.json、cumulative.patch、狀態 next_action、有限等待、原始驗收與 findings 的修正交接、三輪修正上限。保留原 request journal、精確版本、未知派工結果、讀取收據與 stale-review 防護。舊 ChatGPT schema 缺 routing 時採嚴格首行 JSON 相容傳輸，不修改正式連接。

## 真實任務與一般 ChatGPT

- 一般 ChatGPT 對話：[唯讀驗證結果](https://chatgpt.com/c/6aa416e0-6fb0-83ee-82ec-5c7eca00687d)。使用目前 AutoDev，並非 ChatGPT Work、Codex 自評或子代理。
- 已註冊專案：acceptance。唯一新增兩檔：workflow-20260911/labels.js、labels.test.js。
- 功能：字串標籤 trim、忽略空白、toLowerCase 去重、保留首次拼寫／順序、拒絕非陣列／非字串／稀疏陣列，不修改輸入。
- job：`ce12a125-ba0f-49b3-a7e7-ed24a2ac665a`。
- thread：`01a09116-1f72-7f32-864e-9e62c79f3c64`。
- 第一輪 turn：`01a09116-2b66-7cb3-842f-05e255f42f39`；manifest：`01d56e56973b3cabfe04a70cce53b227d07a3fe348b32f03df005f359876724a`。
- 第二輪 turn：`01a0911a-870e-7392-8812-67f87f464249`；manifest：`04362ae7a0cb7db3a3484a93ff8ea95a521f1b94b9f913efc2fc2c44aa8a2ed5`。

這是刻意安排的測試先行驗收：第一輪建立完整測試及未實作 stub，真實執行指定測試得到 9 fail／0 pass／exit 1。它驗證問題回送路徑，不能描述為自然發生的 Codex 漏洞。ChatGPT 讀完六份 artifact 後獨立確認缺少實作，寫入 changes_requested，自行刷新 catalog、呼叫 continue。同一 thread 的第二 turn 完成實作，保留原測試不變，9 pass／0 fail／exit 0，再讀取六份新證據。

兩輪均由 ChatGPT 選擇 `gpt-5.6-terra / medium`，與保存的 `gpt-6-astra / xhigh` 預設不同。第二輪重新判斷後仍選相同模型，未為展示而強制切換。選擇確實傳到 Codex；thread/start、thread/resume 回讀確認 model/effort。0.153.4 Turn 回應不提供逐次推理身份，明確保留 unconfirmed。

第一次舊格式 submit 得到 ROUTING_SELECTION_REQUIRED，確認 no_dispatch、未建立 journal；ChatGPT 自行使用同一 key 加正確標頭重送，沒有人工代寫 findings 或修正代碼。平台要求一次派工確認，已依本次授權允許；未更改永久工具權限。工具清單展開大量 source 時一度發生瀏覽器 CDP timeout，另開同一對話頁面後確認後端已自行完成第二輪；沒有因此重送工作。

最終一般 ChatGPT 自行使用 `workflow.labels.20260911.review.round2.v1` 寫入 pass，再次 status 讀回 `review_status=pass`、`workflow_status=passed`。本機獨立唯讀確認 revision 49／round 2／相同 manifest。測試先行、審查、交回修正與再次審查都在一次普通 ChatGPT 回應中完成（畫面顯示 17m 10s），沒有中途人工搬運 findings 或要求繼續。

最後正常重啟核心，再由同一個一般 ChatGPT 對話實際呼叫 status：job/thread/turn、revision49、round2、manifest、pass/passed 及 routing/thread confirmation 均一致。本機亦獨立比對重啟前後保存的非秘密狀態。這次額外提示只做重啟驗證，不是補救原審查循環；沒有再次派工或填寫review。

## 實際命令

| 範圍 | 命令／證據 | 結果 |
| --- | --- | --- |
| 全產品基線回歸 | npm.cmd run check | exit 0；core 283 項中 281 pass、2 條件 skip；Worker 29 pass；typecheck/build 通過 |
| 最終受影響部分 | node --import tsx --test test/model-routing.test.ts test/planner-input.test.ts test/routing-integration.test.ts test/product.test.ts test/evidence.test.ts test/snapshot.test.ts | 69 pass、0 fail、0 skip；exit 0 |
| 最終編譯 | npm.cmd run build | exit 0 |
| 真實模型發現 | npm.cmd run probe | 官方 ChatGPT subscription／CLI 0.153.4；六個模型及 efforts，無推理呼叫 |
| 真實 Codex 第一輪 | node --test workflow-20260911/labels.test.js | 9 fail；exit 1，刻意保留的測試先行結果 |
| 真實 Codex 修正輪 | 同一指定命令 | 9 pass；exit 0 |
| 本機獨立重跑 | 同一指定命令 | 9 pass；exit 0，不取代 ChatGPT 審查 |
| 既有檔案保全 | .local-tests/workflow-20260911/verify-preservation.mjs | 25 個原檔 SHA-256 一致；只新增兩檔；source omissions 空 |

全產品測試包含 Windows PowerShell 5.1 與 PowerShell 7 的實際行為，非只有語法解析。兩條 skip 是選用的已安裝 app-server 測試與非 Windows 專用鎖測試；本輪另有真實 catalog 與開發執行證據。最終 69 項含模型／effort 不支援、無預設派工、設定回讀不一致、失敗／quota／auth／transport、不重送不明結果、精確版本、缺頁、過期審查、三輪停止等；未用 mock 代稱 ChatGPT E2E。

實際發現並修正了 harmless DOM `password` 變數及 CSS `#password::placeholder` 被當秘密遮罩的問題。只有精確安全 selector／CSS 形式例外，真實 scalar 密碼與任意函式呼叫仍遮罩；既有 fixture 無須改動。

## 外掛清理與保留

依使用者逐名確認，解除安裝 Ziv AutoDev Spike、AutoDev（已停止的初次測試）、AutoDev（連線更新前），保留目前 AutoDev 與 AutoDev（Quick 備援）。管理工具回報 not_installed 後改用 ChatGPT 可見解除安裝操作；畫面確認已卸載／顯示「安裝外掛程式」。自訂外掛的目錄定義可能仍顯示可安裝，沒有刪除本機資料或歷史證據。

工作區可攜技能保留為選用文件並更新過時指引；日常流程不需要額外安裝它。未更改 OAuth identity、正式 App、project registry 或秘密。

## 使用與限制

依 [日常開發指南](DEVELOPMENT-LOOP.md) 啟動既有 Start-AutoDev.cmd，在一般 ChatGPT 選目前 AutoDev，說「請用 AutoDev 在〈專案〉完成〈需求〉」。指引要求它自己選模型、驗證、獨立審查與交回修正。

這是對話進行中的自動循環；平台確認、訂閱限額、真正產品決策仍可能需要人工。一般 ChatGPT 沒有已驗證可由本機任意喚醒的背景 API，平台結束回合後需回同對話說繼續，先 status 恢復原 job。來源二進位／敏感省略、每檔 2 MiB／專案 32 MiB 界限仍限制完整審查。三次修正仍不通過則保留問題，不無限重跑。未驗證 iOS、整機重新開機後長期自動運作或一般 ChatGPT 對大型專案的工具／上下文上限。

官方核對：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex models](https://learn.chatgpt.com/docs/models)、[ChatGPT Developer mode / MCP](https://developers.openai.com/api/docs/guides/developer-mode)。

## 收尾與下次啟動

依使用者追加的完成後關機要求，保存本輪成果後執行 `scripts/manage-daily.ps1 -Action stop`，exit0；再以 status 確認 core/fixed/native process 均 false。停止服務不刪除任務或 OAuth。下次開機可執行工作區 `Start-AutoDev.cmd`，不需要重建 App；若 ChatGPT 要求重新授權，依平台流程處理。

本次差異獨立保存於父工作區 `.ai-bridge/implementation-diff.patch`，原 patch 保存在 review-backup，`git apply --reverse --check` 通過；保留前輪未提交修改。相關回歸測試通過後未增加無關 E2E。關機採 Windows 正常關機，不強制丟棄未儲存資料；只能確認關機請求已安排，不能在斷電後由本對話證明硬體已關閉。
