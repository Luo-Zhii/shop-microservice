require('dotenv').config();
const express = require('express');
const cors = require('cors');
const config = require('./config');
const { unless } = require('./middleware/auth');
const { setupProxy } = require('./routes/proxy');

const app = express();
const PORT = config.port;

// CORS — allow all origins (matches Java SecurityConfig)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parsing (removed to prevent breaking http-proxy-middleware)
// app.use(express.json());

// JWT Authentication — skip for public paths
app.use(unless(config.publicPaths));

// Setup proxy routes to internal services
const proxyRoutes = setupProxy(app);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    service: 'api-gateway',
    routes: proxyRoutes.map((r) => `${r.path}/** → ${r.target}`),
  });
});

// Global error handler
app.use((err, req, res, next) => {
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      message: 'Invalid or expired token',
      error: err.message,
    });
  }
  console.error('[Gateway] Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`[API Gateway] Running on port ${PORT}`);
  console.log(`[API Gateway] Keycloak issuer: ${config.keycloak.issuer}`);
  console.log(`[API Gateway] Public paths: ${config.publicPaths.join(', ')}`);
});

module.exports = app;
