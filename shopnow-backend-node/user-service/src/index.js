require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sequelize = require('./config/database');
const userRoutes = require('./routes/user.routes');

const app = express();
const PORT = process.env.PORT || 5865;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/user', userRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'UP', service: 'user-service' }));

// Database sync & start
sequelize.sync({ alter: true })
  .then(() => {
    console.log('[DB] PostgreSQL connected & synced');
    app.listen(PORT, () => {
      console.log(`[User Service] Running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  });

module.exports = app;
