require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sequelize = require('./config/database');
const cartRoutes = require('./routes/cart.routes');

const app = express();
const PORT = process.env.PORT || 5863;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/shopping-cart', cartRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'shopping-cart-service' }));

// Database sync & start
sequelize.sync({ alter: true })
  .then(() => {
    console.log('[DB] PostgreSQL connected & synced');
    app.listen(PORT, () => {
      console.log(`[Shopping Cart Service] Running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  });

module.exports = app;
