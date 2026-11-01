'use strict';
const jwt = require('jsonwebtoken');

module.exports = function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next({ status: 401, message: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.id, username: payload.username };
    next();
  } catch {
    next({ status: 401, message: 'Unauthorized' });
  }
};
