'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function authRouter(db) {
  const router = express.Router();

  const stmtFindUser  = db.prepare('SELECT id, username, password FROM users WHERE username = ? COLLATE NOCASE');
  const stmtInsertUser = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');

  function signToken(id, username) {
    return jwt.sign({ id, username }, process.env.JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
  }

  function validateInput(username, password) {
    if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return 'Username must be 3–30 alphanumeric characters or underscores';
    }
    if (!password || typeof password !== 'string' || password.length < 8 || password.length > 72) {
      return 'Password must be 8–72 characters';
    }
    return null;
  }

  // POST /auth/register
  router.post('/register', (req, res, next) => {
    const { username, password } = req.body || {};
    const err = validateInput(username, password);
    if (err) return res.status(422).json({ error: err });

    const existing = stmtFindUser.get(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    try {
      const hash = bcrypt.hashSync(password, 10);
      const result = stmtInsertUser.run(username, hash);
      const token = signToken(result.lastInsertRowid, username);
      res.status(201).json({ token, username });
    } catch (e) {
      console.error('Register error:', e.message);
      next({ status: 500, message: 'Registration failed' });
    }
  });

  // POST /auth/login
  router.post('/login', (req, res, next) => {
    const { username, password } = req.body || {};
    const err = validateInput(username, password);
    if (err) return res.status(422).json({ error: err });

    try {
      const user = stmtFindUser.get(username);
      if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const token = signToken(user.id, user.username);
      res.status(200).json({ token, username: user.username });
    } catch (e) {
      console.error('Login error:', e.message);
      next({ status: 500, message: 'Login failed' });
    }
  });

  return router;
};
