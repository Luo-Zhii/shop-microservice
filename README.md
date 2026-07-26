# ShopNow — E-Commerce Application

Source code ứng dụng ShopNow: Node.js Microservices + React Frontend.

## Cấu trúc

```
shopnow-app/
├── shopnow-backend/              # Java Spring Boot (bản gốc, giữ tham khảo)
│   ├── api-gateway/              # Spring Cloud Gateway :5860
│   ├── config-server/            # Spring Cloud Config Server :5859
│   ├── discovery-server/         # Netflix Eureka :8761
│   ├── product-service/          # Product CRUD :5861
│   ├── shopping-cart-service/    # Cart Management :5863
│   ├── user-service/             # User + JWT Auth :5865
│   ├── keycloak-realms/          # Realm cấu hình Keycloak
│   ├── docker-compose.yaml       # Docker Compose bản Java
│   └── product-data.sql          # Data mẫu sản phẩm
├── shopnow-backend-node/         # Node.js Microservices (bản chính)
│   ├── api-gateway/              # Express + JWT + Proxy :5860
│   ├── product-service/          # Express + Sequelize :5861
│   ├── shopping-cart-service/    # Express + Sequelize :5863
│   ├── user-service/             # Express + Sequelize + Keycloak :5865
│   ├── keycloak-realms/          # Realm cấu hình Keycloak
│   ├── docker-compose.yaml       # Docker Compose bản Node.js
│   ├── product-data.sql          # Data mẫu sản phẩm
│   └── build-and-push.sh         # Script build + push images
├── shopnow-frontend/             # React 18 SPA
│   ├── Dockerfile                # Multi-stage build (Node build + Nginx serve)
│   ├── nginx/default.conf        # Nginx config (SPA routing + API proxy)
│   └── src/                      # Components, Redux, Services
├── docker-compose.yaml           # Docker Compose full stack (BE Node.js + FE)
├── build-and-push.sh             # Script build + push images lên Harbor
└── .gitlab-ci.yml                # CI/CD: Build → Test → Push → Update GitOps
```

## Tech Stack

| Layer | Công nghệ |
|---|---|
| Backend | Node.js 20, Express.js 4.18 |
| ORM | Sequelize 6 + PostgreSQL |
| API Gateway | Express + express-jwt + http-proxy-middleware |
| Database | PostgreSQL 16 |
| Auth | Keycloak 23 + OAuth2 JWT (RS256) |
| Frontend | React 18, Redux, Redux Thunk, Axios |
| UI | Bootstrap 5 + Material UI 5 + react-toastify |
| Container | Docker, Harbor Registry |

## API Endpoints

Tất cả request qua API Gateway (`:5860`), JWT validate tự động trừ signin/signup.

| Method | Endpoint | Auth | Mô tả |
|---|---|---|---|
| POST | `/api/user/signin` | No | Đăng nhập |
| POST | `/api/user/signup` | No | Đăng ký |
| PUT | `/api/user/update/{id}` | JWT | Cập nhật profile |
| DELETE | `/api/user/delete/{id}` | JWT | Xóa user + giỏ hàng |
| GET | `/api/product` | No | Danh sách sản phẩm |
| GET | `/api/product/{id}` | No | Chi tiết sản phẩm |
| POST | `/api/product` | JWT | Thêm sản phẩm |
| PUT | `/api/product/{id}` | JWT | Sửa sản phẩm |
| DELETE | `/api/product/{id}` | JWT | Xóa sản phẩm |
| DELETE | `/api/product/deleteAll` | JWT | Xóa tất cả |
| GET | `/api/shopping-cart` | JWT | Tất cả giỏ hàng |
| GET | `/api/shopping-cart/{id}` | JWT | Giỏ hàng theo ID |
| GET | `/api/shopping-cart/by-name/{name}` | JWT | Giỏ hàng theo tên |
| GET | `/api/shopping-cart/totalprice/{id}` | JWT | Tổng tiền giỏ hàng |
| POST | `/api/shopping-cart?name=` | JWT | Tạo giỏ hàng |
| POST | `/api/shopping-cart/{id}` | JWT | Thêm SP vào giỏ |
| DELETE | `/api/shopping-cart/{id}` | JWT | Xóa giỏ hàng |
| DELETE | `/api/shopping-cart/{id}/products/{productId}` | JWT | Xóa SP khỏi giỏ |
| DELETE | `/api/shopping-cart/deleteAll` | JWT | Xóa tất cả giỏ |

## Khởi chạy

### Full stack (Frontend + Backend)

```bash
docker compose up -d --build
```

| Thành phần | URL |
|---|---|
| Frontend | http://localhost:3000 |
| API Gateway | http://localhost:5860 |
| Keycloak Admin | http://localhost:8080 (admin / admin) |

### Chỉ chạy backend Node.js

```bash
cd shopnow-backend-node && docker compose up -d --build
```

### Chạy dev từng service

```bash
# Cần PostgreSQL + Keycloak chạy trước (qua Docker)
docker run -d --name postgres -p 6543:5432 \
  -e POSTGRES_DB=postgres -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=admin \
  postgres:16-alpine

docker run -d --name keycloak -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  -v $(pwd)/shopnow-backend-node/keycloak-realms:/opt/keycloak/data/import/ \
  quay.io/keycloak/keycloak:23.0.3 start-dev --import-realm

# Mỗi service trong terminal riêng
cd shopnow-backend-node/product-service && npm install && npm start
cd shopnow-backend-node/shopping-cart-service && npm install && npm start
cd shopnow-backend-node/user-service && npm install && npm start
cd shopnow-backend-node/api-gateway && npm install && npm start

# Frontend
cd shopnow-frontend && npm install && npm start
```

## Khác biệt Java vs Node.js

| | Java (shopnow-backend) | Node.js (shopnow-backend-node) |
|---|---|---|
| Số service | 6 (có Discovery + Config Server) | 4 (dùng Docker DNS) |
| Gateway | Spring Cloud Gateway (WebFlux) | Express + http-proxy-middleware |
| Discovery | Netflix Eureka | Docker DNS |
| Config | Spring Cloud Config Server | .env files |
| ORM | Spring Data JPA | Sequelize |
| Password | BCryptPasswordEncoder | bcryptjs |
| HTTP Client | RestTemplate | axios |
| Base image | Java 17 JRE | Node 20 Alpine |

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

## Tài khoản mặc định

| Hệ thống | URL | User / Pass |
|---|---|---|
| Keycloak Admin | http://localhost:8080 | admin / admin |
| App ShopNow | http://localhost:3000 | Tự đăng ký (Sign Up) |
