const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Product = require('./Product');

const ShoppingCart = sequelize.define('shopping_cart', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true,
  },
  shoppingCartName: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    field: 'shopping_cart_name',
  },
}, {
  tableName: 'shopping_cart',
  timestamps: false,
});

// Many-to-Many: ShoppingCart <-> Product
const ShoppingCartProduct = sequelize.define('shopping_cart_product', {}, {
  tableName: 'shopping_cart_product',
  timestamps: false,
});

ShoppingCart.belongsToMany(Product, {
  as: 'products',
  through: ShoppingCartProduct,
  foreignKey: 'shopping_cart_id',
  otherKey: 'product_id',
});
Product.belongsToMany(ShoppingCart, {
  as: 'shopping_carts',
  through: ShoppingCartProduct,
  foreignKey: 'product_id',
  otherKey: 'shopping_cart_id',
});

module.exports = { ShoppingCart, Product, ShoppingCartProduct };
