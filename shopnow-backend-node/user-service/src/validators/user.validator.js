const { body } = require('express-validator');

const loginValidator = [
  body('username')
    .notEmpty().withMessage('Username is required'),
  body('password')
    .notEmpty().withMessage('Password is required'),
];

const signupValidator = [
  body('username')
    .notEmpty().withMessage('Username is required')
    .isLength({ min: 3, max: 30 }).withMessage('Username must be between 3 and 30 characters'),
  body('email')
    .notEmpty().withMessage('Email is required')
    .isEmail().withMessage('Invalid email format'),
  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 6, max: 40 }).withMessage('Password must be between 6 and 40 characters'),
];

const updateUserValidator = [
  body('password')
    .optional()
    .isLength({ min: 6, max: 40 }).withMessage('Password must be between 6 and 40 characters'),
  body('email')
    .optional()
    .isEmail().withMessage('Invalid email format')
    .isLength({ max: 50 }).withMessage('Email must be at most 50 characters'),
];

module.exports = { loginValidator, signupValidator, updateUserValidator };
