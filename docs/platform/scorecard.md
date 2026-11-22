# Service scorecard (sinh tự động bởi `python -m aiops.scorecard`)

Luật: **tests** (bronze) Có test tự động; **deploy_config** (bronze) Có Helm values trong repo GitOps; **ci_build** (bronze) Được CI build + ký image; **owner** (bronze) Có owner trong CODEOWNERS; **network_policy** (silver) NetworkPolicy bật, ingress không mở cả namespace; **autoscaling** (silver) Có autoscaling (HPA/KEDA); **aiops_monitored** (silver) AIOps giám sát (có trong danh sách service); **slo** (silver) Có SLO ràng buộc (error budget); **canary** (gold) Triển khai canary (Argo Rollouts); **chaos** (gold) Có thí nghiệm chaos nhắm vào; **kpi** (gold) Có KPI nghiệp vụ/UX có hướng.

| Service | Mức | Điểm | tests | deploy_config | ci_build | owner | network_policy | autoscaling | aiops_monitored | slo | canary | chaos | kpi |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| accounting | 🥇 Gold | 100% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ai-service | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| api-gateway | 🥈 Silver | 82% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| cart | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| catalog | 🥈 Silver | 91% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| identity | 🥉 Bronze | 73% | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | · | · | ✓ |
| inventory | 🥈 Silver | 82% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · |
| notification | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| order | 🥇 Gold | 100% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| payment | 🥇 Gold | 100% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| promotion | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| review | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| search | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| seller | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| shipping | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| synthetic | 🥉 Bronze | 46% | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| user-profile | 🥈 Silver | 73% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| warehouse | 🥇 Gold | 100% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Tỉ lệ service đạt từng luật: tests 100%, deploy_config 100%, ci_build 100%, owner 100%, network_policy 94%, autoscaling 94%, aiops_monitored 94%, slo 94%, canary 33%, chaos 33%, kpi 28%.
