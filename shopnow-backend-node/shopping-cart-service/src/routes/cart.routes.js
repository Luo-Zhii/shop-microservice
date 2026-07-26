const express = require('express');
const router = express.Router();
const controller = require('../controllers/CartController');

// IMPORTANT: Static routes must come BEFORE parameterized routes
router.get('/', controller.getAllCarts.bind(controller));
router.post('/', controller.createCart.bind(controller));
router.delete('/deleteAll', controller.deleteAllCarts.bind(controller));
router.get('/by-name/:name', controller.getCartByName.bind(controller));
router.get('/totalprice/:id', controller.getTotalPrice.bind(controller));
router.get('/:id', controller.getCartById.bind(controller));
router.post('/:id', controller.addProductsToCart.bind(controller));
router.delete('/:id/products/:productId', controller.removeProduct.bind(controller));
router.delete('/:id', controller.deleteCartById.bind(controller));

module.exports = router;
