const userService = require('../services/UserService');
const { validationResult } = require('express-validator');

class UserController {
  /**
   * POST /api/user/signin
   */
  async signin(req, res) {
    // Validation check
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array().map(e => e.msg) });
    }

    try {
      const result = await userService.authenticateUser(req.body);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message });
    }
  }

  /**
   * POST /api/user/signup
   */
  async signup(req, res) {
    // Validation check
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array().map(e => e.msg) });
    }

    try {
      const result = await userService.registerUser(req.body);
      res.status(201).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message });
    }
  }

  /**
   * PUT /api/user/update/:userId
   */
  async update(req, res) {
    // Validation check
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array().map(e => e.msg) });
    }

    try {
      const result = await userService.updateUser(req.params.userId, req.body);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message });
    }
  }

  /**
   * DELETE /api/user/delete/:userId
   */
  async delete(req, res) {
    try {
      const result = await userService.deleteUser(req.params.userId);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message });
    }
  }
}

module.exports = new UserController();
