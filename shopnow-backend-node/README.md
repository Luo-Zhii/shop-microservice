# ShopNow Backend — Node.js Microservices

Backend Node.js cho ứng dụng ShopNow, chuyển đổi từ Java Spring Boot Microservices.

## Kiến trúc

```
shopnow-backend-node/
├── api-gateway/                 # API Gateway (Express + JWT + Proxy)
│   ├── Dockerfile
│   └── src/
│       ├── index.js             # Entry point :5860
│       ├── config/index.js      # Port, Keycloak, service URLs
│       ├── middleware/auth.js    # JWT validation (express-jwt + jwks-rsa)
│       └── routes/proxy.js      # Proxy → internal services
├── product-service/             # Product CRUD (Express + Sequelize)
│   ├── Dockerfile
│   └── src/
│       ├── index.js             # Entry point :5861
│       ├── config/database.js   # PostgreSQL connection
│       ├── models/Product.js    # Sequelize model
│       ├── services/ProductService.js
│       ├── controllers/ProductController.js
│       └── routes/product.routes.js
├── shopping-cart-service/       # Cart Management (Express + Sequelize)
│   ├── Dockerfile
│   └── src/
│       ├── index.js             # Entry point :5863
│       ├── config/database.js
│       ├── models/Product.js, ShoppingCart.js
│       ├── services/CartService.js  # Tính giá = gọi REST sang Product Service
│       ├── controllers/CartController.js
│       └── routes/cart.routes.js
├── user-service/                # User + Auth (Express + Sequelize + Keycloak)
│   ├── Dockerfile
│   └── src/
│       ├── index.js             # Entry point :5865
│       ├── config/database.js
│       ├── models/User.js
│       ├── validators/user.validator.js
│       ├── services/UserService.js   # BCrypt + Keycloak token + Cart delete
│       ├── controllers/UserController.js
│       └── routes/user.routes.js
├── docker-compose.yaml          # 7 services: gateway + 3 business + postgres + keycloak + mysql
├── product-data.sql             # Dữ liệu mẫu
└── keycloak-realms/
    └── realm-export.json        # Realm cấu hình Keycloak
```

## Tech Stack

| Layer | Công nghệ |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | Express.js 4.18 |
| ORM | Sequelize 6 + PostgreSQL |
| Auth | Keycloak 23 + JWT (RS256) |
| Validation | express-validator |
| Password | bcryptjs |
| Proxy | http-proxy-middleware |
| Container | Docker + Alpine |

## API Endpoints (giữ nguyên từ bản Java)

| Service | Method | Path | Auth |
|---|---|---|---|
| User | POST | `/api/user/signin` | No |
| User | POST | `/api/user/signup` | No |
| User | PUT | `/api/user/update/{userId}` | JWT |
| User | DELETE | `/api/user/delete/{userId}` | JWT |
| Product | GET | `/api/product` | JWT |
| Product | GET | `/api/product/{id}` | JWT |
| Product | POST | `/api/product` | JWT |
| Product | PUT | `/api/product/{id}` | JWT |
| Product | DELETE | `/api/product/{id}` | JWT |
| Product | DELETE | `/api/product/deleteAll` | JWT |
| Cart | GET | `/api/shopping-cart` | JWT |
| Cart | GET | `/api/shopping-cart/{id}` | JWT |
| Cart | GET | `/api/shopping-cart/by-name/{name}` | JWT |
| Cart | GET | `/api/shopping-cart/totalprice/{id}` | JWT |
| Cart | POST | `/api/shopping-cart?name=` | JWT |
| Cart | POST | `/api/shopping-cart/{id}` | JWT |
| Cart | DELETE | `/api/shopping-cart/{id}` | JWT |
| Cart | DELETE | `/api/shopping-cart/deleteAll` | JWT |

## Khởi chạy

```bash
# Khởi động toàn bộ hệ thống
docker-compose up -d --build

# Xem logs
docker-compose logs -f

# Dừng
docker-compose down
```

## Khác biệt so với bản Java

| Bản Java | Bản Node.js |
|---|---|
| 6 services (gateway + 3 business + discovery + config) | 4 services (gateway + 3 business) |
| Spring Cloud Gateway (WebFlux) | Express + http-proxy-middleware |
| Netflix Eureka Discovery | Docker DNS (không cần discovery) |
| Spring Cloud Config Server | .env files + docker-compose env |
| Spring Data JPA | Sequelize ORM |
| Apache HttpClient | axios |
| BCryptPasswordEncoder | bcryptjs |
