const cartService = require('../services/CartService');

class CartController {
  async createCart(req, res) {
    try {
      const { name } = req.query;
      const cart = await cartService.createCart(name);
      res.status(201).json(cart);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }

  async getCartById(req, res) {
    try {
      const cart = await cartService.getCartById(req.params.id);
      res.json(cart);
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async getCartByName(req, res) {
    try {
      const cart = await cartService.getCartByShoppingCartName(req.params.name);
      if (!cart) {
        return res.status(404).json({ message: 'Cart not found' });
      }
      res.json(cart);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }

  async getAllCarts(req, res) {
    try {
      const carts = await cartService.getAllCarts();
      res.json(carts);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }

  async addProductsToCart(req, res) {
    try {
      const cart = await cartService.addProductsToCart(req.params.id, req.body);
      res.json(cart);
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async removeProduct(req, res) {
    try {
      const cart = await cartService.removeProductFromCart(req.params.id, req.params.productId);
      res.json(cart);
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async getTotalPrice(req, res) {
    try {
      const result = await cartService.getShoppingCartPrice(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async deleteCartById(req, res) {
    try {
      await cartService.deleteCartById(req.params.id);
      res.json({ message: 'Cart deleted successfully' });
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async deleteAllCarts(req, res) {
    try {
      const count = await cartService.deleteAllCarts();
      res.json({ message: `${count} carts deleted successfully` });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
}

module.exports = new CartController();
