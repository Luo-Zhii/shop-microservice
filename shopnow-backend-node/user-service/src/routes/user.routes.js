const express = require('express');
const router = express.Router();
const controller = require('../controllers/UserController');
const {
  loginValidator,
  signupValidator,
  updateUserValidator,
} = require('../validators/user.validator');

// Auth routes (public - no JWT required at this level, validated at Gateway)
router.post('/signin', loginValidator, controller.signin.bind(controller));
router.post('/signup', signupValidator, controller.signup.bind(controller));

// User management routes
router.put('/update/:userId', updateUserValidator, controller.update.bind(controller));
router.delete('/delete/:userId', controller.delete.bind(controller));

module.exports = router;
