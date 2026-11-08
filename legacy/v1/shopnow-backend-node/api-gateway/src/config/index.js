require('dotenv').config();

module.exports = {
  port: process.env.PORT || 5860,
  keycloak: {
    issuer: process.env.KEYCLOAK_ISSUER || 'http://keycloak:8080/realms/java-microservice-realm',
    jwksUri:
      process.env.KEYCLOAK_JWKS_URI ||
      'http://keycloak:8080/realms/java-microservice-realm/protocol/openid-connect/certs',
  },
  services: {
    product: process.env.PRODUCT_SERVICE_URL || 'http://product-service:5861',
    cart: process.env.CART_SERVICE_URL || 'http://shopping-cart-service:5863',
    user: process.env.USER_SERVICE_URL || 'http://user-service:5865',
  },
  // Public endpoints that don't require JWT
  publicPaths: [
    '/api/user/signin',
    '/api/user/signup',
    '/health',
    '/swagger-ui',
    '/v3/api-docs',
    '/eureka',
  ],
};
