'use strict';
const Database = require('better-sqlite3');

function openDb(dbPath) {
  const path = dbPath || process.env.SQLITE_PATH || '/data/whackamoleapi.db';
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password   TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS scores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      score      INTEGER NOT NULL CHECK(score >= 0 AND score <= 9999),
      difficulty TEXT    NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_scores_score      ON scores(score DESC);
    CREATE INDEX IF NOT EXISTS idx_scores_difficulty ON scores(difficulty, score DESC);
  `);
  return db;
}

module.exports = openDb;
