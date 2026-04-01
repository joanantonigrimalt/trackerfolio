'use strict';
// MySQL Proxy API - run on the server (188.245.81.1) to expose DB to Vercel
// This allows Vercel to query the database through HTTP instead of direct TCP connection

const express = require('express');
const mysql2 = require('mysql2/promise');
const cors = require('cors');

const PORT = process.env.DB_PROXY_PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// MySQL Pool
const pool = mysql2.createPool({
  host:     process.env.MYSQL_HOST || 'localhost',
  user:     process.env.MYSQL_USER || 'joanT',
  password: process.env.MYSQL_PASSWORD || '@@JTONY22@@',
  database: process.env.MYSQL_DATABASE || 'joantoni',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.query('SELECT 1');
    conn.release();
    res.json({ status: 'ok', message: 'Database connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Generic query endpoint - for SELECT queries
app.post('/query', async (req, res) => {
  const { sql, params } = req.body;

  if (!sql) return res.status(400).json({ error: 'SQL required' });

  // Security: only allow SELECT queries
  if (!/^\s*SELECT\s/i.test(sql)) {
    return res.status(403).json({ error: 'Only SELECT queries allowed' });
  }

  try {
    const [rows] = await pool.query(sql, params || []);
    res.json({ data: rows, count: rows.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Exec endpoint - for INSERT/UPDATE/DELETE
app.post('/exec', async (req, res) => {
  const { sql, params } = req.body;
  const token = req.headers['x-db-token'];

  // Simple token auth
  if (token !== process.env.DB_PROXY_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!sql) return res.status(400).json({ error: 'SQL required' });

  try {
    const [result] = await pool.query(sql, params || []);
    res.json({
      affectedRows: result.affectedRows || 0,
      insertId: result.insertId || null,
      changedRows: result.changedRows || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// User endpoints
app.post('/auth/login', async (req, res) => {
  const { email } = req.body;

  try {
    const [rows] = await pool.query(
      'SELECT id, email, password_hash FROM users WHERE email = ?',
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/users/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, email, email_confirmed_at, full_name, created_at FROM users WHERE id = ?',
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Portfolio data
app.get('/positions/:userId', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM user_positions WHERE user_id = ? ORDER BY created_at DESC',
      [req.params.userId]
    );

    res.json({ data: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[DB Proxy] Listening on port ${PORT}`);
});
