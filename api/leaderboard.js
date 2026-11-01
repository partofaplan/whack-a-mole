'use strict';
const express = require('express');

module.exports = function leaderboardRouter(db) {
  const router = express.Router();

  const SQL_GLOBAL = `
    SELECT
      ROW_NUMBER() OVER (ORDER BY best_score DESC) AS rank,
      u.username,
      sub.best_score   AS score,
      sub.difficulty,
      sub.achieved_at  AS timestamp
    FROM (
      SELECT
        user_id,
        difficulty,
        MAX(score)      AS best_score,
        MAX(created_at) AS achieved_at
      FROM scores
      GROUP BY user_id, difficulty
    ) sub
    JOIN users u ON u.id = sub.user_id
    ORDER BY best_score DESC
    LIMIT 10
  `;

  const SQL_FILTERED = `
    SELECT
      ROW_NUMBER() OVER (ORDER BY best_score DESC) AS rank,
      u.username,
      sub.best_score   AS score,
      sub.difficulty,
      sub.achieved_at  AS timestamp
    FROM (
      SELECT
        user_id,
        difficulty,
        MAX(score)      AS best_score,
        MAX(created_at) AS achieved_at
      FROM scores
      WHERE difficulty = ?
      GROUP BY user_id, difficulty
    ) sub
    JOIN users u ON u.id = sub.user_id
    ORDER BY best_score DESC
    LIMIT 10
  `;

  const stmtGlobal   = db.prepare(SQL_GLOBAL);
  const stmtFiltered = db.prepare(SQL_FILTERED);

  // GET /leaderboard[?difficulty=easy|medium|hard]
  router.get('/', (req, res, next) => {
    const { difficulty } = req.query;
    if (difficulty !== undefined && !['easy', 'medium', 'hard'].includes(difficulty)) {
      return res.status(422).json({ error: 'difficulty must be easy, medium, or hard' });
    }
    try {
      const rows = difficulty ? stmtFiltered.all(difficulty) : stmtGlobal.all();
      res.status(200).json({ leaderboard: rows });
    } catch (e) {
      console.error('Leaderboard query error:', e.message);
      next({ status: 500, message: 'Leaderboard unavailable' });
    }
  });

  return router;
};
