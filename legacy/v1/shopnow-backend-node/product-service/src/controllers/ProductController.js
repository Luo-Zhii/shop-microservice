const productService = require('../services/ProductService');

class ProductController {
  async getAll(req, res) {
    try {
      const products = await productService.getAllProducts();
      res.json(products);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }

  async getById(req, res) {
    try {
      const product = await productService.getProductById(req.params.id);
      res.json(product);
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async create(req, res) {
    try {
      const product = await productService.createProduct(req.body);
      res.status(201).json(product);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }

  async update(req, res) {
    try {
      const product = await productService.updateProduct(req.params.id, req.body);
      res.json(product);
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async deleteById(req, res) {
    try {
      await productService.deleteProduct(req.params.id);
      res.json({ message: 'Product deleted successfully' });
    } catch (err) {
      res.status(404).json({ message: err.message });
    }
  }

  async deleteAll(req, res) {
    try {
      const count = await productService.deleteAllProducts();
      res.json({ message: `${count} products deleted successfully` });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
}

module.exports = new ProductController();
