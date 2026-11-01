'use strict';
const express = require('express');
const authenticate = require('./middleware/authenticate');

module.exports = function scoresRouter(db) {
  const router = express.Router();
  const stmtInsert = db.prepare(
    'INSERT INTO scores (user_id, score, difficulty) VALUES (?, ?, ?)'
  );

  // POST /scores — requires auth
  router.post('/', authenticate, (req, res, next) => {
    const { score, difficulty } = req.body || {};
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 9999) {
      return res.status(422).json({ error: 'score must be an integer between 0 and 9999' });
    }
    if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      return res.status(422).json({ error: 'difficulty must be easy, medium, or hard' });
    }
    try {
      const result = stmtInsert.run(req.user.id, score, difficulty);
      res.status(201).json({
        id: result.lastInsertRowid,
        username: req.user.username,
        score,
        difficulty,
        created_at: Math.floor(Date.now() / 1000)
      });
    } catch (e) {
      console.error('Score insert error:', e.message);
      next({ status: 500, message: 'Failed to save score' });
    }
  });

  return router;
};
