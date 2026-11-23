---
id: RB-007
title: Chatbot về chế độ FAQ — hết ngân sách LLM hoặc kill switch
services: [ai-service]
alerts: [LlmBudgetLow, LlmDegraded]
tags: [llm, finops, budget, chatbot, kill-switch]
chaos: null          # diễn tập trên bàn (tabletop) — không có thí nghiệm chaos tái hiện
---
## Triệu chứng
Chatbot trả lời theo FAQ/mẫu; ai_llm_degraded{reason} = 1; ngân sách ngày còn < 20%.

## Chẩn đoán
GET /llm/budget của ai-service: chi phí theo tính năng. Chi phí tăng bất thường → kiểm lưu lượng chat (bot?), vòng lặp.

## Khắc phục
Đây là hạ cấp có chủ đích, khách vẫn được trả lời. Chỉ nâng LLM_DAILY_BUDGET_USD qua PR nếu có phê duyệt chi phí.

## Xác minh
Sang ngày mới tự mở lại; theo dõi shopnow:llm_cost_usd_per_hour.
