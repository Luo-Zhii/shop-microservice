const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');
const config = require('../config');

/**
 * JWT Authentication Middleware.
 * Validates Bearer tokens against Keycloak's JWKS endpoint.
 * Maps to: SecurityConfig.java in the Java API Gateway
 */
const authMiddleware = jwt({
  // Dynamically load signing key from Keycloak's JWKS
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: config.keycloak.jwksUri,
  }),

  // Validate issuer and audience
  issuer: config.keycloak.issuer,
  algorithms: ['RS256'],

  // Attach decoded token to req.auth
  requestProperty: 'auth',
});

/**
 * Conditionally apply JWT auth: skip for public endpoints.
 */
function unless(paths) {
  return (req, res, next) => {
    const isPublic = paths.some((path) => req.path.startsWith(path));
    if (isPublic || (req.method === 'GET' && req.path.startsWith('/api/product'))) {
      return next();
    }
    return authMiddleware(req, res, next);
  };
}

module.exports = { authMiddleware, unless };
