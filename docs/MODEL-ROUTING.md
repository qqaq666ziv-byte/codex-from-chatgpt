# AutoDev 模型選擇

2026-09-11 的實作已由固定 profile/quality 表改為一般 ChatGPT 依實際任務與官方即時 catalog 選擇。完整協定、日常使用與限制見 [專案建立後的開發循環](DEVELOPMENT-LOOP.md)。

新任務須明確傳入 routing.model 與 routing.effort；缺少時回傳能力清單，請規劃者自主補選，且不派工、不建立 request journal。rationale 與 verification 是選用欄位。catalog 保留官方模型及 effort 描述。

明確選擇經驗證後實際傳入 Codex。沒有固定的任務類型分級、模型評分或默默回到預設。舊 routingPolicy 設定與舊 evidence 仍可讀取；設定中的 profiles/quality 已不決定新派工，不需要清空正式設定。

2026-09-06 的 routing-1 是歷史行為，相關驗收見 [當日交付](DELIVERY-2026-09-06.md)。本次變更前的文件及程式已保留於被 Git 忽略的 .local-tests/workflow-20260911/，既有原始碼未提交變更也一併保留。
