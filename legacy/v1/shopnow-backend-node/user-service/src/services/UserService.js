const User = require('../models/User');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const KEYCLOAK_TOKEN_URL =
  process.env.KEYCLOAK_TOKEN_URL ||
  'http://keycloak:8080/realms/java-microservice-realm/protocol/openid-connect/token';
const KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'spring-cloud-client';
const KEYCLOAK_CLIENT_SECRET =
  process.env.KEYCLOAK_CLIENT_SECRET || 'AJufwN1eof8P5Gga5Y9atCFqdMuZEuKd';
const KEYCLOAK_GRANT_TYPE = process.env.KEYCLOAK_GRANT_TYPE || 'client_credentials';
const KEYCLOAK_SCOPE = process.env.KEYCLOAK_SCOPE || 'openid offline_access';
const CART_SERVICE_URL =
  process.env.CART_SERVICE_URL || 'http://shopping-cart-service:5863';

class UserService {
  /**
   * Register a new user.
   * Maps to: UserService.registerUser(SignupRequest) in Java
   */
  async registerUser({ username, email, password }) {
    // Check existing username
    const existingUsername = await User.findOne({ where: { username } });
    if (existingUsername) {
      const error = new Error('Error: Username is already taken!');
      error.status = 400;
      throw error;
    }

    // Check existing email
    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) {
      const error = new Error('Error: Email is already in use!');
      error.status = 400;
      throw error;
    }

    // Hash password with BCrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    await User.create({
      username,
      email,
      password: hashedPassword,
    });

    return { message: 'User registered successfully!' };
  }

  /**
   * Authenticate user: verify credentials, then get JWT from Keycloak.
   * Maps to: UserService.authenticateUser(LoginRequest) in Java
   */
  async authenticateUser({ username, password }) {
    // 1. Find user by username or email
    const isEmail = username.includes('@');
    const user = await User.findOne({
      where: isEmail ? { email: username } : { username }
    });
    if (!user) {
      const error = new Error('Invalid username or password');
      error.status = 401;
      throw error;
    }

    // 2. Verify password with BCrypt
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      const error = new Error('Invalid username or password');
      error.status = 401;
      throw error;
    }

    // 3. Get JWT token from Keycloak
    let accessToken;
    try {
      const params = new URLSearchParams();
      params.append('grant_type', KEYCLOAK_GRANT_TYPE);
      params.append('client_id', KEYCLOAK_CLIENT_ID);
      params.append('client_secret', KEYCLOAK_CLIENT_SECRET);
      params.append('scope', KEYCLOAK_SCOPE);

      const response = await axios.post(KEYCLOAK_TOKEN_URL, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      accessToken = response.data.access_token;
    } catch (err) {
      console.error('[UserService] Keycloak token error:', err.message);
      const error = new Error('Failed to obtain authentication token');
      error.status = 500;
      throw error;
    }

    // 4. Return JWT response (matches JwtResponse in Java)
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      accessToken: accessToken,
      type: 'Bearer',
    };
  }

  /**
   * Update user profile (email and/or password).
   * Maps to: UserService.updateUser(Long, UpdateUserRequest) in Java
   */
  async updateUser(userId, { password, email }) {
    const user = await User.findByPk(userId);
    if (!user) {
      const error = new Error('User not found');
      error.status = 404;
      throw error;
    }

    // Update password if provided
    if (password) {
      const salt = await bcrypt.genSalt(10);
      user.password = await bcrypt.hash(password, salt);
    }

    // Update email if provided
    if (email) {
      const existingEmail = await User.findOne({ where: { email } });
      if (existingEmail && existingEmail.id !== user.id) {
        const error = new Error('Error: Email is already in use!');
        error.status = 400;
        throw error;
      }
      user.email = email;
    }

    await user.save();
    return { message: 'User updated successfully!' };
  }

  /**
   * Delete user and their associated shopping cart.
   * Maps to: UserService.deleteUser(Long) in Java
   */
  async deleteUser(userId) {
    const user = await User.findByPk(userId);
    if (!user) {
      const error = new Error('User not found');
      error.status = 404;
      throw error;
    }

    const username = user.username;

    // Delete user first
    await user.destroy();

    // Try to find and delete the associated shopping cart
    try {
      const cartResponse = await axios.get(
        `${CART_SERVICE_URL}/api/shopping-cart/by-name/${username}`
      );
      if (cartResponse.data && cartResponse.data.id) {
        await axios.delete(
          `${CART_SERVICE_URL}/api/shopping-cart/${cartResponse.data.id}`
        );
        console.log(`[UserService] Deleted cart for user: ${username}`);
      }
    } catch (err) {
      // Cart not found or service unavailable - not critical, just log
      console.log(`[UserService] No cart found for user ${username} or cart service unavailable`);
    }

    return { message: 'User deleted successfully!' };
  }
}

module.exports = new UserService();
