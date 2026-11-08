const Product = require('../models/Product');

class ProductService {
  async getProductById(productId) {
    const product = await Product.findByPk(productId);
    if (!product) {
      throw new Error('Product not found');
    }
    return product;
  }

  async getAllProducts() {
    return await Product.findAll();
  }

  async createProduct(productData) {
    return await Product.create(productData);
  }

  async updateProduct(productId, productData) {
    const product = await this.getProductById(productId);
    const { name, price, category, description } = productData;
    await product.update({ name, price, category, description });
    return product;
  }

  async deleteProduct(productId) {
    const product = await this.getProductById(productId);
    await product.destroy();
    return product;
  }

  async deleteAllProducts() {
    const count = await Product.destroy({ where: {}, truncate: true });
    return count;
  }
}

module.exports = new ProductService();
