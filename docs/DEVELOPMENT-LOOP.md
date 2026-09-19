# 專案建立後的開發循環

2026-09-11。專案由使用者建立並註冊；本流程不要求 GitHub、API credits、新訂閱或重新建立 ChatGPT App。實測結果另見本輪驗證報告，以下描述程式的協定。

## 日常使用

1. 啟動工作區既有的 `Start-AutoDev.cmd --no-pause`。專案已經註冊時不需要再建立。
2. 在一般 ChatGPT 的「對話」介面選用現有 AutoDev，直接說：

   > 請用 AutoDev 在「我的專案」加入搜尋與空結果提示，沿用目前風格；自行選擇 Codex 模型與推理強度，完成必要驗證後由你獨立審查，有成立的問題就交回修正，直到通過或遇到具體阻礙。

   如果有多個專案，第一次指定名稱或 ID。後續直接提出普通需求即可；不要用 Codex review 或「工作」取代要求的一般 ChatGPT reviewer。
3. ChatGPT 自行走完派工、等待、讀證據、審查與必要修正；使用者只處理平台確認、真正產品決策與額外權限。

`autodev_projects` 的回傳及 MCP server instructions 內含完整循環指引。舊 App 的工具 schema 若完全沒有 `routing`，ChatGPT 會在 requirements 第一行放入精確的 `AutoDev-Routing: {"model":"所選模型","effort":"支援的強度","rationale":"選擇理由","verification":"驗證策略"}`，換行後接原始任務。本機使用同一個嚴格 schema 驗證，完整保存文字及選擇；不會從普通敘述猜模型。這是 ChatGPT 自行使用的相容傳輸，不需使用者寫控制標頭，也不需更換 OAuth 或 App identity。

## 模型如何選擇

一般 ChatGPT 是決策者。本機 `model/list` 提供當下帳號可見模型、官方描述、支援的 effort 與輸入型態；ChatGPT 依任務的歧義、影響、先前審查問題與這份清單判斷，送出明確 model / effort。沒有任務類型對模型的固定分級表，也沒有另一個需付費的分類 API。

`autodev_projects` 在快取過期時刷新清單。新派工再次驗證清單有效、模型存在、effort 與 modality 相容。新模型不必加入本機評分表即可被選用。舊設定中的 quality/profiles 可繼續解析以保留設定，但已不決定派工。

缺少選擇會回 `ROUTING_SELECTION_REQUIRED`，不建立 job 或 journal；ChatGPT 補選後可使用原 request_key。明確不支援的選擇保存 blocked，沒有執行回合；傳輸結果不明則保留 uncertain，不能換 key 重新派工。沒有自動改 API key、provider 或額外付費 fallback。

證據分開記錄：

- `routing_decision`：ChatGPT 選擇、本機驗證、理由與時間。
- `thread_confirmation`：App Server 回讀確認的模型與 effort。
- `turn_confirmation`：目前 0.153.4 的 Turn 回應不提供模型/effort，明確標為 unconfirmed；thread 設定不能冒充每次推理的後端證明。

每輪真正傳入 `thread/start` 或同 thread 的 resume/settings update，再傳入 `turn/start.model/effort`。切換設定必須有匹配通知與回讀；失敗不派下一輪。保留現有安全恢復機制。

## 審查與修正

`autodev_status` 對執行中工作最多等待 20 秒，回傳 `workflow_status` 與 `next_action`。ChatGPT 在這個對話回合中繼續呼叫，直到終止狀態。它必須讀完 manifest 的所有 artifact 分頁：

- requirements.json：原始及目前驗收。
- changes.patch：本輪差異。
- cumulative.patch：從任務原始版本到目前版本的完整差異。
- source.json：目前全部可安全擷取的來源內容與遺漏資訊，包含未修改的相依程式。
- execution.json：實際執行命令、結果、退出碼與 routing 證據。
- source-identity.json：前後版本的檔案 hash 與來源限制。

一般 ChatGPT 獨立判斷後呼叫 `autodev_review`。讀取收據綁定認證連接、manifest 與全部分頁；版本改變或證據不完整不能 pass。程式只證明認證連接與證據身分，無法密碼學驗證遠端 reviewer 是哪個模型；真實 ChatGPT 驗收需另有一般對話的可見工具呼叫證據。

`changes_requested` 後，ChatGPT 自行呼叫 `autodev_continue`，選擇適合修正工作的模型與 effort。伺服器保留原始要求與驗收，將 findings 交給 Codex 核實、修正並驗證。接著審查新的 manifest；舊 manifest 保持不可變。三輪修正仍未通過時停止自動修正，保留成果與未解問題。

驗證依影響決定。程式變更使用有意義的針對性測試，介面變更才考慮實際瀏覽器流程；已通過且未受影響的檢查不用重跑。沒有 test command 時，必須有明確 verification 計畫及實際成功的適用檢查，由 ChatGPT 評估是否充分。伺服器不把一個成功命令當成全部驗收已成立。

## 必須如實呈現的限制

- 這是一般 ChatGPT **對話進行中**的循環。MCP server 不能保證喚醒已結束的對話；遇到平台工具上限、關閉對話或額度限制時，成果保留為 pending。回到同一對話說「繼續這個 AutoDev 任務」後，先用 status 恢復，不能重新 submit 同一工作。
- ChatGPT 的寫入確認與 Codex 額外權限確認由平台決定；本機不繞過。需要新權限、憑證、付費或正式環境操作時停止。
- 來源擷取目前有每檔 2 MiB、每專案 32 MiB 的界限；二進位或無法安全讀取的來源需要另外的審查證據，不能假裝完整通過。
- 執行 completed、審查 pending、routing blocked、recovery_required、stale_review 分開呈現。只有目前來源的持久 review pass 才可報工作流通過。
- 現有服務必須在安全重啟後才會載入新程式；build 成功不代表執行中的舊程序已升級。

官方核對來源（2026-09-11）：[App Server](https://learn.chatgpt.com/docs/app-server)、[模型與 effort](https://learn.chatgpt.com/docs/models)、[一般 ChatGPT Developer mode / MCP](https://developers.openai.com/api/docs/guides/developer-mode)。官方提供模型發現、逐回合設定與 ChatGPT MCP 工具串接；沒有將一般對話等同於可由本機任意喚醒的背景 API。
