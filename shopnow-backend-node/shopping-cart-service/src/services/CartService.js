const { ShoppingCart, Product } = require('../models/ShoppingCart');
const axios = require('axios');

const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://product-service:5861';

class CartService {
  async createCart(name) {
    return await ShoppingCart.create({ shoppingCartName: name });
  }

  async getCartById(cartId) {
    const cart = await ShoppingCart.findByPk(cartId, {
      include: ['products'],
    });
    if (!cart) {
      throw new Error('Cart not found');
    }
    return cart;
  }

  async getCartByShoppingCartName(name) {
    const cart = await ShoppingCart.findOne({
      where: { shoppingCartName: name },
      include: ['products'],
    });
    return cart; // Returns null if not found (matches Java behavior)
  }

  async getAllCarts() {
    return await ShoppingCart.findAll({
      include: ['products'],
    });
  }

  async addProductsToCart(cartId, products) {
    const cart = await this.getCartById(cartId);

    for (const productData of products) {
      // Find or create product in cart DB (use ID from Product Service)
      const [product] = await Product.findOrCreate({
        where: { id: productData.id },
        defaults: {
          id: productData.id,
          name: productData.name,
          price: productData.price,
          description: productData.description,
          category: productData.category,
        },
      });

      // Update product info in case it changed
      await product.update({
        name: productData.name,
        price: productData.price,
        description: productData.description,
        category: productData.category,
      });

      // Add to cart if not already present
      await cart.addProduct(product);
    }

    return await this.getCartById(cartId);
  }

  async removeProductFromCart(cartId, productId) {
    const cart = await this.getCartById(cartId);
    await cart.removeProduct(productId);
    return cart;
  }

  async getShoppingCartPrice(cartId) {
    const cart = await this.getCartById(cartId);
    let totalPrice = 0;

    for (const product of cart.products) {
      try {
        const response = await axios.get(
          `${PRODUCT_SERVICE_URL}/api/product/${product.id}`
        );
        totalPrice += Number(response.data.price);
      } catch (err) {
        console.error(`[CartService] Error getting product ${product.id} price:`, err.message);
        // Fallback: use local product price
        totalPrice += Number(product.price);
      }
    }

    return { totalPrice, total_price: totalPrice };
  }

  async deleteCartById(cartId) {
    const cart = await ShoppingCart.findByPk(cartId);
    if (!cart) {
      throw new Error('Cart not found');
    }
    await cart.destroy();
    return cart;
  }

  async deleteAllCarts() {
    const count = await ShoppingCart.destroy({ where: {}, truncate: true });
    return count;
  }
}

module.exports = new CartService();
