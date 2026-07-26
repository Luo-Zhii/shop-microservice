const express = require('express');
const router = express.Router();
const controller = require('../controllers/ProductController');

router.get('/', controller.getAll.bind(controller));
router.get('/:id', controller.getById.bind(controller));
router.post('/', controller.create.bind(controller));
router.put('/:id', controller.update.bind(controller));
router.delete('/deleteAll', controller.deleteAll.bind(controller));
router.delete('/:id', controller.deleteById.bind(controller));

module.exports = router;
