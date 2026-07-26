const { createProxyMiddleware } = require('http-proxy-middleware');
const config = require('../config');

/**
 * Proxy configuration.
 * Routes requests to internal microservices.
 * Maps to Spring Cloud Gateway route definitions in Java:
 *
 *   /api/product/**      → lb://PRODUCT-SERVICE
 *   /api/shopping-cart/** → lb://SHOPPING-CART-SERVICE
 *   /api/user/**          → lb://USER-SERVICE
 */
const proxyRoutes = [
  {
    path: '/api/product',
    target: config.services.product,
    service: 'Product Service',
  },
  {
    path: '/api/shopping-cart',
    target: config.services.cart,
    service: 'Shopping Cart Service',
  },
  {
    path: '/api/user',
    target: config.services.user,
    service: 'User Service',
  },
];

function setupProxy(app) {
  proxyRoutes.forEach(({ path, target, service }) => {
    console.log(`[Gateway] ${path}/** → ${target} (${service})`);

    app.use(
      path,
      createProxyMiddleware({
        target,
        changeOrigin: true,
        pathRewrite: (p) => p, // Keep original path
        on: {
          proxyReq: (proxyReq, req, res) => {
            // Forward auth info if needed (decoded JWT is in req.auth)
            if (req.auth) {
              proxyReq.setHeader('X-Auth-User', req.auth.preferred_username || '');
              proxyReq.setHeader('X-Auth-Email', req.auth.email || '');
            }
          },
          error: (err, req, res) => {
            console.error(`[Gateway] Proxy error (${service}):`, err.message);
            if (!res.headersSent) {
              res.status(502).json({
                message: `Service unavailable: ${service}`,
                error: err.message,
              });
            }
          },
        },
      })
    );
  });

  return proxyRoutes;
}

module.exports = { setupProxy };
