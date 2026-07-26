const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Product = sequelize.define('product_cart', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: false,  // Use ID from Product Service
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  price: {
    type: DataTypes.BIGINT,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  category: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  tableName: 'product_cart',
  timestamps: false,
});

module.exports = Product;
