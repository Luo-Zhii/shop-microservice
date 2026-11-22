# Service scorecard (sinh tự động bởi `python -m aiops.scorecard`)

Luật: **tests** (bronze) Có test tự động; **deploy_config** (bronze) Có Helm values trong repo GitOps; **ci_build** (bronze) Được CI build + ký image; **owner** (bronze) Có owner trong CODEOWNERS; **network_policy** (silver) NetworkPolicy bật, ingress không mở cả namespace; **autoscaling** (silver) Có autoscaling (HPA/KEDA); **aiops_monitored** (silver) AIOps giám sát (có trong danh sách service); **slo** (silver) Có SLO ràng buộc (error budget); **canary** (gold) Triển khai canary (Argo Rollouts); **chaos** (gold) Có thí nghiệm chaos nhắm vào; **kpi** (gold) Có KPI nghiệp vụ/UX có hướng.

| Service | Mức | Điểm | tests | deploy_config | ci_build | owner | network_policy | autoscaling | aiops_monitored | slo | canary | chaos | kpi |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| accounting | 🥉 Bronze | 64% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | ✓ | · |
| ai-service | 🥉 Bronze | 55% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · |
| api-gateway | 🥈 Silver | 82% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| cart | 🥉 Bronze | 64% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | · | · |
| catalog | 🥉 Bronze | 82% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | ✓ | · |
| identity | 🥉 Bronze | 55% | ✓ | ✓ | ✓ | ✓ | · | · | ✓ | · | · | · | ✓ |
| inventory | 🥈 Silver | 82% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · |
| notification | 🥉 Bronze | 64% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · |
| order | 🥇 Gold | 100% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| payment | 🥇 Gold | 100% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| promotion | 🥉 Bronze | 55% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · |
| review | 🥉 Bronze | 55% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · |
| search | 🥉 Bronze | 64% | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · |
| seller | 🥉 Bronze | 55% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · |
| shipping | 🥉 Bronze | 55% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · |
| user-profile | 🥉 Bronze | 55% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · |
| warehouse | 🥉 Bronze | 64% | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · | · | ✓ | · |

Tỉ lệ service đạt từng luật: tests 100%, deploy_config 100%, ci_build 100%, owner 100%, network_policy 94%, autoscaling 41%, aiops_monitored 100%, slo 29%, canary 24%, chaos 35%, kpi 18%.
