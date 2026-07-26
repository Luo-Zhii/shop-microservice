# ShopNow — E-Commerce Application

Source code ứng dụng ShopNow: Spring Boot Microservices + React Frontend.

## Cấu trúc

```
shopnow-app/
├── shopnow-backend/           # Spring Boot Microservices (Java 17)
│   ├── api-gateway/              # Spring Cloud Gateway :5860
│   ├── config-server/            # Spring Cloud Config Server :5859
│   ├── discovery-server/         # Netflix Eureka :8761
│   ├── product-service/          # Product CRUD :5861
│   ├── shopping-cart-service/    # Cart Management :5863
│   ├── user-service/             # User + JWT Auth :5865
│   ├── keycloak-realms/          # Realm cấu hình Keycloak
│   ├── docker-compose.yaml       # Docker Compose cho local dev
│   └── product-data.sql          # Data mẫu sản phẩm
├── shopnow-frontend/          # React 18 SPA
│   ├── Dockerfile                # Multi-stage build
│   └── src/
├── build-and-push.sh          # Script build + push images lên Harbor
└── .gitlab-ci.yml              # CI/CD: Build → Test → Push → Update GitOps
```

## Tech Stack

| Layer | Công nghệ |
|---|---|
| Backend | Java 17, Spring Boot 3.1, Spring Cloud 2022.0.4 |
| API Gateway | Spring Cloud Gateway (WebFlux) |
| Service Discovery | Netflix Eureka |
| Config | Spring Cloud Config (native mode) |
| Database | PostgreSQL 15, MySQL 5.7 |
| Auth | Keycloak 23 + OAuth2 JWT |
| Frontend | React 18, Redux, Axios |
| Container | Docker, Harbor Registry |

## Luồng CI/CD GitOps

```
Developer push code → GitLab CI triggers:
  1. SAST scan (Semgrep + Trivy)
  2. Build Docker images → push Harbor
  3. Deploy staging (docker-compose test)
  4. DAST scan (OWASP ZAP)
  5. Update image tag → shopnow-gitops repo
       └→ ArgoCD detects → auto deploy K8s
```

## Cài đặt

```bash
# Build images
./build-and-push.sh

# Hoặc push code để trigger GitLab CI pipeline
git push origin main
```
