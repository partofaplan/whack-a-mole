'use strict';

// Startup guard — fail fast if JWT_SECRET is absent
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set');
  process.exit(1);
}

const express = require('express');
const cors    = require('cors');
const openDb  = require('./db');

const db  = openDb();
const app = express();

// Middleware
app.use(cors({
  origin: [
    'https://whackamole.tail18466c.ts.net',
    'https://whackamolemobile.tail18466c.ts.net'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10kb' }));

// Health probe — registered before routes
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));

// Routes
app.use('/auth',        require('./auth')(db));
app.use('/scores',      require('./scores')(db));
app.use('/leaderboard', require('./leaderboard')(db));

// 404
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`whackamoleapi listening on :${PORT}`));
