'use strict';
// finasset API server - MySQL backend replacing Supabase

const express    = require('express');
const mysql2     = require('mysql2/promise');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcrypt');
const cors       = require('cors');
const nodemailer  = require('nodemailer');

// Web Push (VAPID)
let _webpush = null;
try {
  _webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    _webpush.setVapidDetails(
      'mailto:' + (process.env.SMTP_FROM || 'noreply@finasset.app'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('[webpush] VAPID configured');
  }
} catch(e) { console.log('[webpush] Not available:', e.message); }

const rateLimit   = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
// Anthropic (lazy — only instantiated when API key is set)
let _anthropicClient = null;
function getAnthropic() {
  if (_anthropicClient) return _anthropicClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  _anthropicClient = new Anthropic({ apiKey: key });
  return _anthropicClient;
}

// Load env
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/\\n/g,'').trim();
  }
}

const PORT        = process.env.API_PORT || 4001;
const JWT_SECRET  = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXP     = '7d';
const SALT_ROUNDS = 10;
const APP_URL     = process.env.API_BASE_URL || 'https://finasset.app';

// MySQL pool
const pool = mysql2.createPool({
  host:     process.env.MYSQL_HOST     || 'localhost',
  user:     process.env.MYSQL_USER     || 'joanT',
  password: process.env.MYSQL_PASSWORD || '@@JTONY22@@',
  database: process.env.MYSQL_DATABASE || 'joantoni',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

// Nodemailer (Brevo SMTP) — transport created lazily per call so env vars are always fresh
function createMailer() {
  return nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendConfirmationEmail(email, token) {
  const confirmUrl = `${APP_URL}/auth/v1/verify?token=${token}`;
  await createMailer().sendMail({
    from: `"FinAsset" <${process.env.SMTP_FROM||process.env.SMTP_USER}>`,
    to: email,
    subject: 'Confirma tu cuenta en FinAsset',
    html: `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr><td style="background:#1a1a1a;padding:32px;text-align:center;">
          <span style="color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px;">Finasset</span>
        </td></tr>
        <tr><td style="padding:40px 40px 32px;">
          <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:22px;">Confirma tu cuenta</h2>
          <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
            Gracias por registrarte. Haz clic en el boton para verificar tu email y empezar a usar Finasset.
          </p>
          <a href="${confirmUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
            Confirmar mi cuenta &rarr;
          </a>
          <p style="margin:32px 0 0;color:#999;font-size:13px;">
            Si no creaste esta cuenta, puedes ignorar este correo.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

const app = express();
app.set('trust proxy', 1); // LiteSpeed sets X-Forwarded-For

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'Too many attempts, try again in 15 minutes.', message: 'Too many attempts, try again in 15 minutes.', status_code: 429 },
  standardHeaders: true, legacyHeaders: false,
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many registrations from this IP.', message: 'Too many registrations from this IP.', status_code: 429 },
  standardHeaders: true, legacyHeaders: false,
});
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset attempts.', message: 'Too many reset attempts.', status_code: 429 },
  standardHeaders: true, legacyHeaders: false,
});
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60, // 60 messages per hour per IP
  message: { error: 'Demasiadas preguntas. Intenta de nuevo en 1 hora.', status_code: 429 },
  standardHeaders: true, legacyHeaders: false,
});

app.use(cors({
  origin: ['https://finasset.app', 'https://www.finasset.app'],
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type','Authorization','apikey','Prefer','Range','X-Client-Info'],
  credentials: true,
}));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Helpers
function makeJWT(userId, email) {
  return jwt.sign({ sub: userId, email, role: 'authenticated' }, JWT_SECRET, { expiresIn: JWT_EXP });
}

function userResponse(user, token) {
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 604800,
    refresh_token: token,
    user: {
      id: user.id,
      email: user.email,
      role: 'authenticated',
      email_confirmed_at: user.email_confirmed_at ? new Date(user.email_confirmed_at).toISOString() : null,
      user_metadata: { full_name: user.full_name || '' },
      app_metadata: { provider: 'email', providers: ['email'] },
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_sign_in_at: user.last_sign_in_at,
    },
  };
}

async function verifyToken(req) {
  const auth = req.headers.authorization || req.headers.apikey || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.sub]);
    const u = rows[0];
    if (!u) return null;
    // Reject token if issued before last logout
    if (u.last_sign_out_at) {
      const issuedAt = payload.iat * 1000;
      const signedOut = new Date(u.last_sign_out_at).getTime();
      if (issuedAt < signedOut) return null;
    }
    return u;
  } catch { return null; }
}

function sendError(res, status, message) {
  res.status(status).json({ error: message, message, status_code: status });
}

function parseFilters(query) {
  const filters = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') continue;
    const m = v.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|in)\.(.+)$/);
    if (m) filters[k] = { op: m[1], val: m[2] };
  }
  return filters;
}

function buildWhere(filters) {
  const clauses = [], params = [];
  for (const [col, { op, val }] of Object.entries(filters)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) continue;
    switch (op) {
      case 'eq':    clauses.push('`' + col + '` = ?'); params.push(val); break;
      case 'neq':   clauses.push('`' + col + '` != ?'); params.push(val); break;
      case 'gt':    clauses.push('`' + col + '` > ?'); params.push(val); break;
      case 'gte':   clauses.push('`' + col + '` >= ?'); params.push(val); break;
      case 'lt':    clauses.push('`' + col + '` < ?'); params.push(val); break;
      case 'lte':   clauses.push('`' + col + '` <= ?'); params.push(val); break;
      case 'like':  clauses.push('`' + col + '` LIKE ?'); params.push(val); break;
      case 'ilike': clauses.push('`' + col + '` LIKE ?'); params.push(val.startsWith('%')||val.endsWith('%')?val:'%'+val+'%'); break;
    }
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

function parseOrder(orderStr) {
  if (!orderStr) return '';
  const parts = orderStr.split(',').map(p => {
    const [col, dir] = p.trim().split('.');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) return null;
    return '`' + col + '` ' + (dir === 'desc' ? 'DESC' : 'ASC');
  }).filter(Boolean);
  return parts.length ? 'ORDER BY ' + parts.join(', ') : '';
}

// POST /auth/v1/signup
app.post('/auth/v1/signup', signupLimiter, async (req, res) => {
  try {
    const { email, password, options } = req.body || {};
    const full_name = options?.data?.full_name || req.body.full_name || '';
    if (!email || !password) return sendError(res, 422, 'Email and password required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 422, 'Invalid email format');
    if (password.length < 6) return sendError(res, 422, 'Password must be at least 6 characters');

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing.length > 0) return sendError(res, 422, 'User already registered');

    const hash  = await bcrypt.hash(password, SALT_ROUNDS);
    const id    = uuidv4();
    const token = crypto.randomBytes(32).toString('hex');
    const now   = new Date();

    await pool.query(
      'INSERT INTO users (id, email, encrypted_password, full_name, confirmation_token, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      [id, email.toLowerCase(), hash, full_name, token, now, now]
    );

    sendConfirmationEmail(email.toLowerCase(), token)
      .then(() => console.log('[email] Sent to', email))
      .catch(e => console.error('[email] Failed:', e.message));

    res.status(200).json({
      id,
      email: email.toLowerCase(),
      confirmation_sent_at: now.toISOString(),
      message: 'Confirmation email sent',
    });
  } catch (e) {
    console.error('[signup]', e.message);
    sendError(res, 500, 'Internal error');
  }
});

// GET /auth/v1/verify?token=...
app.get('/auth/v1/verify', async (req, res) => {
  const { token } = req.query;
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const appPage = isMobile ? '/mobile' : '/desktop';

  if (!token) return res.redirect(APP_URL + appPage + '?error=missing_token');
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE confirmation_token = ? AND email_confirmed_at IS NULL', [token]);
    if (!rows.length) return res.redirect(APP_URL + appPage + '?error=invalid_token');

    const user = rows[0];
    const [_upd] = await pool.query(
      'UPDATE users SET email_confirmed_at = NOW(), confirmation_token = NULL, last_sign_in_at = NOW() WHERE id = ? AND confirmation_token = ?',
      [user.id, token]
    );
    if (!_upd.affectedRows) return res.redirect(APP_URL + appPage + '?error=invalid_token');

    const jwtToken = makeJWT(user.id, user.email);
    res.redirect(APP_URL + appPage + '?auto_token=' + jwtToken);
  } catch (e) {
    console.error('[verify]', e.message);
    res.redirect(APP_URL + appPage + '?error=server_error');
  }
});

// POST /auth/v1/token
app.post('/auth/v1/token', loginLimiter, async (req, res) => {
  // Handle refresh_token grant
  if (req.query.grant_type === 'refresh_token') {
    try {
      const { refresh_token } = req.body || {};
      if (!refresh_token) return sendError(res, 400, 'Refresh token required');
      const payload = jwt.verify(refresh_token, JWT_SECRET);
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.sub]);
      if (!rows.length) return sendError(res, 401, 'User not found');
      const u = rows[0];
      if (!u.email_confirmed_at) return sendError(res, 400, 'Email not confirmed');
      await pool.query('UPDATE users SET last_sign_in_at = NOW() WHERE id = ?', [u.id]);
      const token = makeJWT(u.id, u.email);
      return res.json(userResponse(u, token));
    } catch (e) {
      return sendError(res, 401, 'Invalid refresh token');
    }
  }
  // Handle password grant
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return sendError(res, 400, 'Email and password required');

    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (rows.length === 0) return sendError(res, 400, 'Email no registrado. ¿Tienes una cuenta?');
    const u = rows[0];

    const ok = await bcrypt.compare(password, u.encrypted_password);
    if (!ok) return sendError(res, 400, 'Contraseña incorrecta.');

    if (!u.email_confirmed_at) {
      return sendError(res, 400, 'Email no confirmado. Revisa tu bandeja de entrada.');
    }

    await pool.query('UPDATE users SET last_sign_in_at = NOW() WHERE id = ?', [u.id]);
    const token = makeJWT(u.id, u.email);
    res.json(userResponse(u, token));
  } catch (e) {
    console.error('[token]', e.message);
    sendError(res, 500, 'Internal error');
  }
});

// POST /auth/v1/logout
app.post('/auth/v1/logout', async (req, res) => {
  try {
    const u = await verifyToken(req);
    if (u) {
      await pool.query('UPDATE users SET last_sign_out_at = NOW() WHERE id = ?', [u.id]);
    }
  } catch(_) {}
  res.status(204).send();
});

// GET /auth/v1/user
app.get('/auth/v1/user', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  res.json(userResponse(u, token).user);
});

// PATCH /auth/v1/user — update profile or change password
app.patch('/auth/v1/user', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const { full_name, password, new_password } = req.body || {};
    if (new_password !== undefined) {
      if (new_password.length < 6) return sendError(res, 422, 'New password too short');
      if (!password) return sendError(res, 422, 'Current password required');
      const ok = await bcrypt.compare(password, u.encrypted_password);
      if (!ok) return sendError(res, 400, 'Current password incorrect');
      const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
      await pool.query('UPDATE users SET encrypted_password = ?, last_sign_out_at = NOW(), updated_at = NOW() WHERE id = ?', [hash, u.id]);
    }
    if (full_name !== undefined) {
      await pool.query('UPDATE users SET full_name = ?, updated_at = NOW() WHERE id = ?', [full_name.trim(), u.id]);
    }
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [u.id]);
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    res.json(userResponse(rows[0], token).user);
  } catch (e) {
    console.error('[patch-user]', e.message);
    sendError(res, 500, 'Internal error');
  }
});

// DELETE /auth/v1/user — GDPR account deletion
app.delete('/auth/v1/user', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    await pool.query('DELETE FROM user_positions WHERE user_id = ?', [u.id]);
    await pool.query('DELETE FROM users WHERE id = ?', [u.id]);
    res.json({ message: 'Account deleted' });
  } catch (e) {
    console.error('[delete-user]', e.message);
    sendError(res, 500, 'Internal error');
  }
});

// DELETE /auth/v1/admin/users/:id — admin hard-delete any user
app.delete('/auth/v1/admin/users/:id', async (req, res) => {
  const auth = req.headers.authorization || req.headers.apikey || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== 'service_role') return sendError(res, 403, 'Forbidden');
  } catch { return sendError(res, 401, 'Not authenticated'); }
  const { id } = req.params;
  if (!id) return sendError(res, 400, 'Missing user id');
  try {
    await pool.query('DELETE FROM user_positions WHERE user_id = ?', [id]);
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ message: 'User deleted', id });
  } catch (e) {
    console.error('[admin-delete-user]', e.message);
    sendError(res, 500, 'Internal error');
  }
});

// GET /auth/v1/admin/users
app.get('/auth/v1/admin/users', async (req, res) => {
  const auth = req.headers.authorization || req.headers.apikey || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== 'service_role') return sendError(res, 403, 'Forbidden');
  } catch { return sendError(res, 401, 'Not authenticated'); }
  const [rows] = await pool.query('SELECT id, email, full_name, created_at, updated_at, last_sign_in_at, email_confirmed_at FROM users ORDER BY created_at DESC');
  res.json({
    users: rows.map(u => ({
      id: u.id, email: u.email,
      user_metadata: { full_name: u.full_name || '' },
      created_at: u.created_at, updated_at: u.updated_at,
      last_sign_in_at: u.last_sign_in_at, email_confirmed_at: u.email_confirmed_at,
    })),
    total: rows.length,
  });
});

// POST /auth/v1/recover — send reset email
app.post('/auth/v1/recover', resetLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return sendError(res, 422, 'Email required');
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!rows.length) return res.json({}); // Don't reveal if email exists

    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query('UPDATE users SET reset_token = ?, reset_token_expires_at = ? WHERE id = ?', [token, expires, rows[0].id]);

    const resetUrl = `${APP_URL}/auth/v1/reset-password?token=${token}`;
    await createMailer().sendMail({
      from: `"FinAsset" <${process.env.SMTP_FROM||process.env.SMTP_USER}>`,
      to: email.toLowerCase(),
      subject: 'Restablece tu contraseña en FinAsset',
      html: `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
        <tr><td style="background:#1a1a1a;padding:32px;text-align:center;">
          <span style="color:#fff;font-size:24px;font-weight:700;">Finasset</span>
        </td></tr>
        <tr><td style="padding:40px 40px 32px;">
          <h2 style="margin:0 0 16px;color:#1a1a1a;font-size:22px;">Restablecer contraseña</h2>
          <p style="margin:0 0 24px;color:#555;font-size:15px;line-height:1.6;">
            Haz clic en el botón para crear una nueva contraseña. El enlace expira en 1 hora.
          </p>
          <a href="${resetUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
            Restablecer contraseña &rarr;
          </a>
          <p style="margin:32px 0 0;color:#999;font-size:13px;">Si no solicitaste esto, ignora este correo.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
    });
    res.json({});
  } catch (e) {
    console.error('[recover]', e.message);
    res.json({}); // Always return 200 to not reveal info
  }
});

// GET /auth/v1/reset-password?token=... — show reset form (redirect to app)
app.get('/auth/v1/reset-password', async (req, res) => {
  const { token } = req.query;
  const ua = req.headers['user-agent'] || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const appPage = isMobile ? '/mobile' : '/desktop';
  if (!token) return res.redirect(APP_URL + appPage + '?error=missing_token');
  // Validate token exists and is not expired
  const [rows] = await pool.query(
    'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires_at > NOW()',
    [token]
  );
  if (!rows.length) return res.redirect(APP_URL + appPage + '?error=invalid_or_expired_reset_token');
  res.redirect(APP_URL + appPage + '?reset_token=' + token);
});

// POST /auth/v1/reset-password — set new password
app.post('/auth/v1/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return sendError(res, 422, 'Token and password required');
    if (password.length < 6) return sendError(res, 422, 'Password must be at least 6 characters');

    const [rows] = await pool.query(
      'SELECT * FROM users WHERE reset_token = ? AND reset_token_expires_at > NOW()',
      [token]
    );
    if (!rows.length) return sendError(res, 400, 'Invalid or expired reset token');

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await pool.query(
      'UPDATE users SET encrypted_password = ?, reset_token = NULL, reset_token_expires_at = NULL WHERE id = ?',
      [hash, rows[0].id]
    );

    const jwtToken = makeJWT(rows[0].id, rows[0].email);
    res.json({ access_token: jwtToken, message: 'Password updated successfully' });
  } catch (e) {
    console.error('[reset-password]', e.message);
    sendError(res, 500, 'Internal error');
  }
});

// (refresh_token merged into /auth/v1/token above)

// POST /auth/v1/resend
app.post('/auth/v1/resend', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return sendError(res, 422, 'Email required');
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!rows.length || rows[0].email_confirmed_at) return res.json({});
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE users SET confirmation_token = ? WHERE id = ?', [token, rows[0].id]);
    await sendConfirmationEmail(email.toLowerCase(), token);
    res.json({});
  } catch (e) {
    console.error('[resend]', e.message);
    res.json({});
  }
});

// GET /auth/v1/authorize
app.get('/auth/v1/authorize', async (req, res) => {
  const provider = req.query.provider;
  if (provider === 'google') {
    const redirectTo = req.query.redirect_to || APP_URL;
    return res.redirect(302, `${redirectTo}?error=oauth_not_configured`);
  }
  sendError(res, 400, 'Unknown OAuth provider');
});

// REST endpoints
const ALLOWED_TABLES = new Set(['user_positions','assets','transactions','price_history','community_posts','community_comments','community_likes','referral_codes','referrals']);


// PATCH /rest/v1/community_posts
app.patch('/rest/v1/community_posts', async (req, res) => {
  try {
    const u = await verifyToken(req);
    if (!u) return sendError(res, 401, 'Unauthorized');
    const idParam = req.query.id;
    if (!idParam) return sendError(res, 400, 'id required');
    const postId = idParam.startsWith('eq.') ? idParam.slice(3) : idParam;
    const body = req.body || {};
    const PATCHABLE = ['likes_count', 'content', 'title'];
    const cols = Object.keys(body).filter(k => PATCHABLE.includes(k));
    if (cols.length === 0) return sendError(res, 400, 'No patchable fields');
    const sql = 'UPDATE community_posts SET ' + cols.map(c => c + '=?').join(', ') + ' WHERE id=?';
    await pool.query(sql, [...cols.map(c => body[c]), postId]);
    res.json([]);
  } catch (e) { console.error('PATCH community_posts:', e.message); sendError(res, 500, e.message); }
});

app.get('/rest/v1/:table', async (req, res, next) => {
  const table = req.params.table;
  if (!ALLOWED_TABLES.has(table)) return sendError(res, 404, 'Table not found');
  const _GETSPECIFIC = new Set(['community_posts','community_comments']);
  if (_GETSPECIFIC.has(table)) return next();
  // All tables except public price_history and assets seed require auth
  const publicTables = new Set(['assets','price_history','community_posts','community_likes']);
  let _tableUser = null;
  if (!publicTables.has(table)) {
    _tableUser = await verifyToken(req);
    if (!_tableUser) return sendError(res, 401, 'Not authenticated');
  }
  if (table === 'user_positions' && _tableUser) {
    req.query['user_id'] = 'eq.' + _tableUser.id;
  }
  try {
    const filters = parseFilters(req.query);
    const { where, params } = buildWhere(filters);
    const order  = parseOrder(req.query.order);
    const limit  = parseInt(req.query.limit)  || 1000;
    const offset = parseInt(req.query.offset) || 0;
    const [rows] = await pool.query('SELECT * FROM `' + table + '` ' + where + ' ' + order + ' LIMIT ? OFFSET ?', [...params, limit, offset]);
    // Parse JSON text columns so clients receive objects, not double-encoded strings
    const JSON_TEXT_COLS = { user_positions: ['overrides', 'custom_assets', 'liquidity'] };
    const jsonCols = JSON_TEXT_COLS[table] || [];
    const parsed = jsonCols.length ? rows.map(row => {
      const r = { ...row };
      for (const col of jsonCols) {
        if (typeof r[col] === 'string') {
          try { r[col] = JSON.parse(r[col]); } catch(_) { r[col] = {}; }
        }
      }
      return r;
    }) : rows;
    res.json(parsed);
  } catch (e) { sendError(res, 500, e.message); }
});

app.post('/rest/v1/user_positions', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const prefer  = req.headers['prefer'] || '';
    const isMerge = prefer.includes('merge-duplicates') || prefer.includes('resolution=merge-duplicates');
    const payload = Array.isArray(req.body) ? req.body[0] : req.body;
    const { overrides, custom_assets, liquidity } = payload || {};
    const uid = u.id; // Always use token owner's id — ignore body user_id
    if (isMerge) {
      await pool.query(
        'INSERT INTO user_positions (user_id, overrides, custom_assets, liquidity, updated_at) VALUES (?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE overrides = VALUES(overrides), custom_assets = VALUES(custom_assets), liquidity = VALUES(liquidity), updated_at = NOW()',
        [uid, overrides !== undefined ? JSON.stringify(overrides) : null, custom_assets !== undefined ? JSON.stringify(custom_assets) : null, liquidity !== undefined ? (typeof liquidity === 'string' ? liquidity : JSON.stringify(liquidity)) : null]
      );
    } else {
      await pool.query(
        'REPLACE INTO user_positions (user_id, overrides, custom_assets, liquidity, updated_at) VALUES (?, ?, ?, ?, NOW())',
        [uid, overrides !== undefined ? JSON.stringify(overrides) : null, custom_assets !== undefined ? JSON.stringify(custom_assets) : null, liquidity !== undefined ? (typeof liquidity === 'string' ? liquidity : JSON.stringify(liquidity)) : null]
      );
    }
    const [rows] = await pool.query('SELECT * FROM user_positions WHERE user_id = ?', [uid]);
    // Parse JSON fields back to objects for client
    const parsed = rows.map(r => ({
      ...r,
      overrides: r.overrides ? (typeof r.overrides === 'string' ? JSON.parse(r.overrides) : r.overrides) : null,
      custom_assets: r.custom_assets ? (typeof r.custom_assets === 'string' ? JSON.parse(r.custom_assets) : r.custom_assets) : null,
      liquidity: r.liquidity ? (typeof r.liquidity === 'string' ? (() => { try { return JSON.parse(r.liquidity); } catch { return r.liquidity; } })() : r.liquidity) : null,
    }));
    res.status(201).json(parsed);
  } catch (e) { sendError(res, 500, e.message); }
});

app.post('/rest/v1/price_history', async (req, res) => {
  // Internal cache write — no auth required (public price data caching)
  // Accepts requests from same-origin only (API_BASE_URL = localhost:4001)
  try {
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    if (rows.length === 0) return res.status(201).json([]);
    const sql = 'INSERT INTO price_history (isin, date, close, provider) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE close = VALUES(close), provider = VALUES(provider), updated_at = NOW()';
    for (const row of rows) await pool.query(sql, [row.isin, row.date, row.close, row.provider || 'unknown']);
    res.status(201).json({ inserted: rows.length });
  } catch (e) { sendError(res, 500, e.message); }
});

app.post('/rest/v1/:table', async (req, res, next) => {
  const table = req.params.table;
  if (!ALLOWED_TABLES.has(table)) return sendError(res, 404, 'Table not found');
  const _SPECIFIC = new Set(['community_posts','community_comments','community_likes','referral_codes','referrals']);
  if (_SPECIFIC.has(table)) return next();
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    const results = [];
    for (const row of rows) {
      const cols = Object.keys(row).filter(k => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));
      const vals = cols.map(c => { const v = row[c]; return typeof v === 'object' && v !== null ? JSON.stringify(v) : v; });
      const updates = cols.map(c => '`' + c + '` = VALUES(`' + c + '`)').join(', ');
      const [r] = await pool.query('INSERT INTO `' + table + '` (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ') ON DUPLICATE KEY UPDATE ' + updates, vals);
      results.push({ id: r.insertId || r.affectedRows });
    }
    res.status(201).json(results);
  } catch (e) { sendError(res, 500, e.message); }
});

app.get('/api/auth/config', (req, res) => {
  res.json({ mysqlApiUrl: '', mysqlApiKey: '', supabaseUrl: '', supabaseAnonKey: '' });
});

// Finasset API routes
const WEBAPP_PATH = __dirname;
const API_FILES = [
  ['get',  '/api/auth/lookup-username', WEBAPP_PATH + '/api/auth/lookup-username.js'],
  ['all',  '/api/portfolio/coverage',   WEBAPP_PATH + '/api/portfolio/coverage.js'],
  ['all',  '/api/portfolio/intraday',   WEBAPP_PATH + '/api/portfolio/intraday.js'],
  ['get',  '/api/portfolio/seed',       WEBAPP_PATH + '/api/portfolio/seed.js'],
  ['get',  '/api/dividends/detail',     WEBAPP_PATH + '/api/dividends/detail.js'],
  ['get',  '/api/dividends/history',    WEBAPP_PATH + '/api/dividends/history.js'],
  ['get',  '/api/search/query',         WEBAPP_PATH + '/api/search/query.js'],
  ['get',  '/api/insiders',             WEBAPP_PATH + '/api/insiders.js'],
  ['get',  '/api/etf/profile',          WEBAPP_PATH + '/api/etf/profile.js'],
  ['get',  '/api/fund/profile',         WEBAPP_PATH + '/api/fund/profile.js'],
  ['get',  '/api/cron/warmup',          WEBAPP_PATH + '/api/cron/warmup.js'],
  ['post', '/api/ai/chat',              WEBAPP_PATH + '/api/ai/chat.js'],
];

for (const [method, route, modulePath] of API_FILES) {
  try {
    const handler = require(modulePath);
    const fn = typeof handler === 'function' ? handler : (handler.default || handler);
    app[method](route, (req, res) => {
      try {
        const result = fn(req, res);
        if (result && typeof result.then === 'function') {
          result.catch(e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
        }
      } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
    });
    console.log('[api] Mounted: ' + route);
  } catch (e) { console.warn('[api] Could not load ' + route + ': ' + e.message); }
}

// ── Plan & credits helpers ──────────────────────────────────────────────────
const PLAN_LIMITS = {
  free:    { assets: 5,   aiCreditsMonth: 0,    aiDailyAnon: 3   },
  starter: { assets: 9999, aiCreditsMonth: 50,  aiDailyAnon: 999 },
  pro:     { assets: 9999, aiCreditsMonth: 500, aiDailyAnon: 999 },
};
// Credits per plan per month (mapped to ~msgs: 1 credit ≈ 8 msgs with Haiku)
// starter=50 → ~400 msgs  |  pro=500 → ~4000 msgs

async function getUserPlan(userId) {
  if (!userId) return 'free';
  const [rows] = await pool.query(
    "SELECT plan, plan_expires_at FROM users WHERE id = ?", [userId]
  );
  if (!rows.length) return 'free';
  const { plan, plan_expires_at } = rows[0];
  if (plan_expires_at && new Date(plan_expires_at) < new Date()) {
    await pool.query("UPDATE users SET plan='free', plan_expires_at=NULL WHERE id=?", [userId]);
    return 'free';
  }
  return plan || 'free';
}

async function getAICredits(userId, plan) {
  const month = new Date().toISOString().slice(0,7);
  const limit = PLAN_LIMITS[plan]?.aiCreditsMonth ?? 0;
  const [rows] = await pool.query(
    "SELECT credits_used FROM ai_credits WHERE user_id=? AND month=?", [userId, month]
  );
  const used = rows.length ? rows[0].credits_used : 0;
  // Ensure row exists
  if (!rows.length) {
    await pool.query(
      "INSERT IGNORE INTO ai_credits(user_id,month,credits_used,credits_limit) VALUES(?,?,0,?)",
      [userId, month, limit]
    );
  }
  return { used, limit, remaining: Math.max(0, limit - used), month };
}

async function consumeAICredit(userId) {
  const month = new Date().toISOString().slice(0,7);
  await pool.query(
    "INSERT INTO ai_credits(user_id,month,credits_used,credits_limit) VALUES(?,?,1,0) ON DUPLICATE KEY UPDATE credits_used=credits_used+1",
    [userId, month]
  );
}

async function checkAnonAILimit(req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const hash = require('crypto').createHash('sha256').update(ip).digest('hex').slice(0,16);
  const day  = new Date().toISOString().slice(0,10);
  const [rows] = await pool.query(
    "SELECT count FROM ai_usage_anon WHERE ip_hash=? AND day=?", [hash, day]
  );
  const count = rows.length ? rows[0].count : 0;
  if (count >= 3) return { allowed: false, count };
  await pool.query(
    "INSERT INTO ai_usage_anon(ip_hash,day,count) VALUES(?,?,1) ON DUPLICATE KEY UPDATE count=count+1",
    [hash, day]
  );
  return { allowed: true, count: count + 1 };
}


// ── Alert Notifications (email + Web Push) ───────────────────────────────

async function sendAlertEmail(toEmail, assetName, condition, targetPrice, currentPrice, currency) {
  const sym = currency === 'USD' ? '$' : currency === 'GBP' ? '\u00a3' : '\u20ac';
  const cond = condition === 'above' ? 'superado' : 'bajado de';
  const fmt = n => parseFloat(n || 0).toFixed(2);
  const subject = `\u25c9 Alerta activada: ${assetName}`;
  const condColor = condition === 'above' ? '#15803d' : '#dc2626';
  const condLabel = condition === 'above' ? '&#9650; Por encima' : '&#9660; Por debajo';
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:32px 0;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:480px;width:100%;">
<tr><td style="background:#142018;padding:24px 32px;">
  <span style="color:#f5fbf6;font-size:20px;font-weight:700;">Finasset</span>
</td></tr>
<tr><td style="padding:32px 32px 24px;">
  <h2 style="margin:0 0 8px;color:#142018;font-size:20px;">Alerta de precio activada</h2>
  <p style="margin:0 0 20px;color:#5a6e5e;font-size:14px;line-height:1.6;">
    Tu alerta para <strong>${assetName}</strong> se ha activado. El precio ha ${cond} el nivel establecido.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border-collapse:separate;border-spacing:8px;">
    <tr>
      <td style="background:#f7faf8;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:10px;font-weight:700;color:#8fa090;text-transform:uppercase;margin-bottom:4px">Precio objetivo</div>
        <div style="font-size:20px;font-weight:800;color:#142018">${sym}${fmt(targetPrice)}</div>
        <div style="font-size:11px;font-weight:700;color:${condColor};margin-top:2px">${condLabel}</div>
      </td>
      <td style="background:#f7faf8;border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:10px;font-weight:700;color:#8fa090;text-transform:uppercase;margin-bottom:4px">Precio actual</div>
        <div style="font-size:20px;font-weight:800;color:#15803d">${sym}${fmt(currentPrice)}</div>
        <div style="font-size:11px;color:#8fa090;margin-top:2px">Al activarse</div>
      </td>
    </tr>
  </table>
  <a href="${APP_URL}/mobile" style="display:block;text-align:center;background:#15803d;color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-size:14px;font-weight:700;">Ver mi cartera &rarr;</a>
</td></tr>
<tr><td style="padding:16px 32px;text-align:center;border-top:1px solid #f0f4f1;">
  <p style="margin:0;font-size:11px;color:#b0c0b5;">Finasset &middot; <a href="${APP_URL}/mobile" style="color:#15803d;text-decoration:none">Gestionar alertas</a></p>
</td></tr>
</table>
</td></tr></table></body></html>`;
  await createMailer().sendMail({
    from: `"FinAsset" <${process.env.SMTP_FROM||process.env.SMTP_USER}>`,
    to: toEmail, subject, html
  });
}

app.get('/api/alerts/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/alerts/subscribe', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Unauthorized');
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) return sendError(res, 400, 'Invalid subscription');
  const { v4: uuidv4 } = require('uuid');
  try {
    await pool.query(
      'INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth_key,created_at) VALUES (?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE p256dh=VALUES(p256dh),auth_key=VALUES(auth_key),created_at=NOW()',
      [uuidv4(), u.id, subscription.endpoint, subscription.keys?.p256dh||'', subscription.keys?.auth||'']
    );
    res.json({ ok: true });
  } catch(e) { sendError(res, 500, e.message); }
});

app.delete('/api/alerts/subscribe', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Unauthorized');
  const { endpoint } = req.body || {};
  if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', [u.id, endpoint]);
  res.json({ ok: true });
});

app.post('/api/alerts/notify', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Unauthorized');
  const { alertName, condition, targetPrice, currentPrice, sendEmail, currency } = req.body || {};
  const sym = currency === 'USD' ? '$' : currency === 'GBP' ? '\u00a3' : '\u20ac';
  const fmt = n => parseFloat(n || 0).toFixed(2);
  const cond = condition === 'above' ? 'superado' : 'bajado de';
  const pushBody = `${alertName} ha ${cond} ${sym}${fmt(targetPrice)} \u00b7 Actual: ${sym}${fmt(currentPrice)}`;
  try {
    const [users] = await pool.query('SELECT email FROM users WHERE id=?', [u.id]);
    const email = users[0]?.email;
    if (sendEmail && email) {
      sendAlertEmail(email, alertName, condition, targetPrice, currentPrice, currency)
        .catch(e => console.error('[alert-email]', e.message));
    }
    if (_webpush && process.env.VAPID_PUBLIC_KEY) {
      const [subs] = await pool.query('SELECT * FROM push_subscriptions WHERE user_id=?', [u.id]);
      const payload = JSON.stringify({ title: '\u25c9 Alerta de precio', body: pushBody, url: '/mobile' });
      const toDelete = [];
      for (const sub of subs) {
        try {
          await _webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }, payload);
        } catch(e) { if (e.statusCode === 410 || e.statusCode === 404) toDelete.push(sub.id); }
      }
      if (toDelete.length) await pool.query('DELETE FROM push_subscriptions WHERE id IN (?)', [toDelete]);
    }
    res.json({ ok: true });
  } catch(e) { sendError(res, 500, e.message); }
});


// GET /api/admin/user-positions — returns all users' position counts (service role only)
app.get('/api/admin/user-positions', async (req, res) => {
  try {
    const auth = (req.headers.authorization || req.headers.apikey || '').replace(/^Bearer\s+/i, '').trim();
    if (!auth) return sendError(res, 401, 'Unauthorized');
    const payload = require('jsonwebtoken').verify(auth, JWT_SECRET);
    if (payload.role !== 'service_role') return sendError(res, 403, 'Forbidden');
    const [rows] = await pool.query('SELECT user_id, overrides, custom_assets, updated_at FROM user_positions');
    res.json(rows);
  } catch(e) { sendError(res, 401, 'Invalid token'); }
});
// GET /auth/v1/plan — returns current plan + AI credits for authenticated user
app.get('/auth/v1/plan', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || '';
    if (!authHeader.startsWith('Bearer ')) return sendError(res, 401, 'Unauthorized');
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const plan = await getUserPlan(payload.sub);
    const credits = await getAICredits(payload.sub, plan);
    const limits = PLAN_LIMITS[plan];
    res.json({ plan, credits, limits });
  } catch(e) { sendError(res, 401, 'Invalid token'); }
});


// ── Vera AI Chat ────────────────────────────────────────────────────────────
function buildVeraSystem(portfolio, userEmail) {
  const isEs = (portfolio && portfolio.lang) ? portfolio.lang !== 'en' : true;
  let sys = `Eres Vera, la IA financiera personal de Finasset. Eres experta en inversión, carteras de activos, diversificación, análisis de riesgo y planificación financiera.

PERSONALIDAD: Directa, precisa e inteligente. Usas los datos reales del portfolio del usuario para dar análisis concretos y personalizados. Eres como un analista financiero personal que conoce la cartera en detalle.

IDIOMA: ${isEs ? 'Responde SIEMPRE en español, sin excepción.' : 'Always respond in English only.'}

FORMATO DE RESPUESTA:
- Usa markdown: **negrita** para cifras importantes, - para listas
- Respuestas de 2-4 párrafos máximos. Concisa pero completa.
- Usa los datos numéricos reales del portfolio en tus respuestas
- Si el usuario no tiene posiciones, anímale a añadir su primera posición

REGLAS IMPORTANTES:
- Nunca te identifiques como Claude ni menciones Anthropic. Eres Vera, IA de Finasset.
- Cuando des consejos de inversión concretos, añade al final: *Esto no constituye asesoramiento financiero regulado.*
- Si preguntan sobre acciones/activos que no están en el portfolio, responde basándote en tu conocimiento general de mercados.
`;

  if (portfolio && portfolio.assetCount > 0) {
    sys += `
═══════════════════════════════════════
PORTFOLIO ACTUAL DEL USUARIO${userEmail ? ' (' + userEmail + ')' : ''}
═══════════════════════════════════════
Valor total: ${portfolio.totalValue || '—'}
Capital invertido: ${portfolio.invested || '—'}
Rentabilidad acumulada: ${portfolio.gainPct >= 0 ? '+' : ''}${portfolio.gainPct}% (${portfolio.gainAmt || '—'})
Health Score: ${portfolio.score || '—'}/100
Liquidez disponible: ${portfolio.liquidity || '0'}
Número de posiciones: ${portfolio.assetCount}
`;
    if (portfolio.assets && portfolio.assets.length > 0) {
      sys += `
POSICIONES DETALLADAS:
`;
      for (const a of portfolio.assets) {
        const gain = parseFloat(a.gainPct);
        sys += `• ${a.ticker}${a.name && a.name !== a.ticker ? ' – ' + a.name : ''}: ${a.shares ? a.shares + ' uds · ' : ''}Valor: ${a.value} · Coste: ${a.invested} · ${gain >= 0 ? '+' : ''}${a.gainPct}%${a.sector ? ' · ' + a.sector : ''}
`;
      }
    }
    sys += `═══════════════════════════════════════
`;
  } else {
    sys += `
El usuario aún no tiene posiciones en su portfolio.
`;
  }
  return sys;
}

app.post('/ai/chat', aiLimiter, async (req, res) => {
  try {
    const client = getAnthropic();
    if (!client) {
      return res.status(503).json({ error: 'IA no disponible. Configura ANTHROPIC_API_KEY en el servidor.' });
    }
    const { messages, portfolio } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return sendError(res, 400, 'messages required');
    }
    // Auth + plan enforcement
    let userEmail = null;
    let userId = null;
    let userPlan = 'free';
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
        userEmail = payload.email;
        userId = payload.sub;
        userPlan = await getUserPlan(userId);
      } catch (e) { /* anon */ }
    }
    // Check credits / limits
    if (userId) {
      const credits = await getAICredits(userId, userPlan);
      if (credits.remaining <= 0) {
        return res.status(402).json({
          error: 'Sin créditos de IA este mes.',
          plan: userPlan,
          credits,
          upgrade_url: '/pricing'
        });
      }
    } else {
      // Anonymous / free — daily IP limit
      const anonCheck = await checkAnonAILimit(req);
      if (!anonCheck.allowed) {
        return res.status(402).json({
          error: 'Límite diario alcanzado. Regístrate para tener más acceso.',
          limit: 3,
          upgrade_url: '/pricing'
        });
      }
    }
    const systemPrompt = buildVeraSystem(portfolio || {}, userEmail);
    // Sanitize messages
    const cleanMsgs = messages.slice(-14).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content || '').slice(0, 3000)
    }));
    // Ensure last message is user
    if (cleanMsgs[cleanMsgs.length - 1].role !== 'user') {
      return sendError(res, 400, 'Last message must be from user');
    }
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      system: systemPrompt,
      messages: cleanMsgs,
    });
    const content = response.content[0]?.text || '';
    // Consume 1 credit if authenticated and return updated credits
    if (userId) {
      await consumeAICredit(userId);
      const updatedCredits = await getAICredits(userId, userPlan);
      res.json({ content, credits: updatedCredits });
    } else {
      res.json({ content });
    }
  } catch (e) {
    console.error('[AI] error:', e.message);
    res.status(500).json({ error: 'Error de IA: ' + e.message });
  }
});


app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ status: 'error', db: e.message }); }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[unhandled]', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});



// ─── Community & Referral tables ──────────────────────────────────────────────
// Extend ALLOWED_TABLES at runtime
['community_posts','community_comments','community_likes','referral_codes','referrals']
  .forEach(t => ALLOWED_TABLES.add(t));

// ── Generic DELETE /rest/v1/:table ────────────────────────────────────────────
app.delete('/rest/v1/:table', async (req, res) => {
  const table = req.params.table;
  if (!ALLOWED_TABLES.has(table)) return sendError(res, 404, 'Table not found');
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const filters = parseFilters(req.query);
    if (['community_posts','community_comments','user_positions'].includes(table)) {
      filters.user_id = { op: 'eq', val: u.id };
    }
    if (table === 'community_likes') filters.user_id = { op: 'eq', val: u.id };

    // community_likes: decrement counter
    if (table === 'community_likes') {
      const postId = (filters.post_id || {}).val;
      const [r] = await pool.query('DELETE FROM community_likes WHERE post_id = ? AND user_id = ?', [postId, u.id]);
      if (r.affectedRows > 0) await pool.query('UPDATE community_posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = ?', [postId]);
      return res.json({ deleted: r.affectedRows });
    }
    // community_posts: cascade delete
    if (table === 'community_posts') {
      const postId = (filters.id || {}).val;
      if (postId) {
        const [check] = await pool.query('SELECT id FROM community_posts WHERE id = ? AND user_id = ?', [postId, u.id]);
        if (!check.length) return sendError(res, 403, 'Forbidden');
        await pool.query('DELETE FROM community_likes WHERE post_id = ?', [postId]);
        await pool.query('DELETE FROM community_comments WHERE post_id = ?', [postId]);
        await pool.query('DELETE FROM community_posts WHERE id = ?', [postId]);
        return res.json({ deleted: 1 });
      }
    }
    const { where, params } = buildWhere(filters);
    if (!where) return sendError(res, 400, 'Delete requires at least one filter');
    const [r] = await pool.query('DELETE FROM `' + table + '` ' + where, params);
    res.json({ deleted: r.affectedRows });
  } catch (e) {
    console.error('[DELETE ' + table + ']', e.message);
    sendError(res, 500, e.message);
  }
});

// ── GET /rest/v1/community_posts — public feed with author info ───────────────
app.get('/rest/v1/community_posts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    // Frontend uses 'post_type' but DB column is 'type' — translate
    if (req.query['post_type']) { req.query['type'] = req.query['post_type']; delete req.query['post_type']; }
    const filters = parseFilters(req.query);
    const { where, params } = buildWhere(filters);
    const sql = 'SELECT p.*, p.type AS post_type, u.full_name AS display_name FROM community_posts p LEFT JOIN users u ON u.id = p.user_id ' + where + ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    const [rows] = await pool.query(sql, [...params, limit, offset]);
    res.json(rows);
  } catch (e) { sendError(res, 500, e.message); }
});

// ── POST /rest/v1/community_posts ─────────────────────────────────────────────
app.post('/rest/v1/community_posts', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    // Accept both 'type' and 'post_type' (mobile uses post_type)
    const type = body.type || body.post_type || 'text';
    const content = body.content || null;
    // Store everything except server-managed fields as payload
    const { user_id: _uid, display_name: _dn, post_type: _pt, type: _t, content: _c, ...rest } = body;
    const payloadData = Object.keys(rest).length > 0 ? rest : (body.payload || null);
    const id = uuidv4();
    await pool.query('INSERT INTO community_posts (id, user_id, type, content, payload) VALUES (?,?,?,?,?)',
      [id, u.id, type, content, payloadData ? JSON.stringify(payloadData) : null]);
    const [rows] = await pool.query('SELECT p.*, u.email AS author_email, u.full_name AS author_name FROM community_posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { sendError(res, 500, e.message); }
});

// ── GET /rest/v1/community_comments ──────────────────────────────────────────
app.get('/rest/v1/community_comments', async (req, res) => {
  try {
    const filters = parseFilters(req.query);
    const { where, params } = buildWhere(filters);
    const sql = 'SELECT c.*, u.email AS author_email, u.full_name AS author_name FROM community_comments c LEFT JOIN users u ON u.id = c.user_id ' + where + ' ORDER BY c.created_at ASC LIMIT 100';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (e) { sendError(res, 500, e.message); }
});

// ── POST /rest/v1/community_comments ─────────────────────────────────────────
app.post('/rest/v1/community_comments', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const { post_id, content } = body;
    if (!post_id || !content) return sendError(res, 422, 'post_id and content required');
    const id = uuidv4();
    await pool.query('INSERT INTO community_comments (id, post_id, user_id, content) VALUES (?,?,?,?)', [id, post_id, u.id, content]);
    await pool.query('UPDATE community_posts SET comments_count = comments_count + 1 WHERE id = ?', [post_id]);
    const [rows] = await pool.query('SELECT c.*, u.email AS author_email, u.full_name AS author_name FROM community_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { sendError(res, 500, e.message); }
});

// ── GET /rest/v1/community_likes ──────────────────────────────────────────────
app.get('/rest/v1/community_likes', async (req, res) => {
  try {
    const filters = parseFilters(req.query);
    const { where, params } = buildWhere(filters);
    const [rows] = await pool.query('SELECT * FROM community_likes ' + where + ' LIMIT 200', params);
    res.json(rows);
  } catch (e) { sendError(res, 500, e.message); }
});

// ── POST /rest/v1/community_likes — like + increment ─────────────────────────
app.post('/rest/v1/community_likes', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const { post_id } = body;
    if (!post_id) return sendError(res, 422, 'post_id required');
    const [r] = await pool.query('INSERT IGNORE INTO community_likes (post_id, user_id) VALUES (?,?)', [post_id, u.id]);
    if (r.affectedRows > 0) await pool.query('UPDATE community_posts SET likes_count = likes_count + 1 WHERE id = ?', [post_id]);
    res.status(201).json({ post_id, user_id: u.id });
  } catch (e) { sendError(res, 500, e.message); }
});

// ── referral_codes ────────────────────────────────────────────────────────────
app.get('/rest/v1/referral_codes', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  const [rows] = await pool.query('SELECT * FROM referral_codes WHERE user_id = ?', [u.id]);
  res.json(rows);
});

app.post('/rest/v1/referral_codes', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  try {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const { code } = body;
    await pool.query('INSERT IGNORE INTO referral_codes (user_id, code) VALUES (?,?)', [u.id, code]);
    const [rows] = await pool.query('SELECT * FROM referral_codes WHERE user_id = ?', [u.id]);
    res.status(201).json(rows[0]);
  } catch (e) { sendError(res, 500, e.message); }
});

// ── referrals ─────────────────────────────────────────────────────────────────
app.get('/rest/v1/referrals', async (req, res) => {
  const u = await verifyToken(req);
  if (!u) return sendError(res, 401, 'Not authenticated');
  const [rows] = await pool.query('SELECT * FROM referrals WHERE referrer_id = ?', [u.id]);
  res.json(rows);
});

app.post('/rest/v1/referrals', async (req, res) => {
  try {
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const { referrer_id, referred_id } = body;
    if (!referrer_id || !referred_id) return sendError(res, 422, 'referrer_id and referred_id required');
    const id = uuidv4();
    await pool.query('INSERT IGNORE INTO referrals (id, referrer_id, referred_id) VALUES (?,?,?)', [id, referrer_id, referred_id]);
    res.status(201).json({ ok: true });
  } catch (e) { sendError(res, 500, e.message); }
});


// ── GET /api/ter/fetch?isin=ISIN1,ISIN2,... ──────────────────────────────────
// Scrapes FT Markets for Ongoing charge. Caches in DB for 1 year (fees rarely change).
// Returns { results: { "ISIN": ter_percent, ... } }
const FT_SCRAPE_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.5',
};
async function scrapeFTMarketsTER(isin) {
  for (const ccy of ['EUR', 'GBP', 'USD']) {
    try {
      const url = `https://markets.ft.com/data/funds/tearsheet/summary?s=${encodeURIComponent(isin)}:${ccy}`;
      const r = await fetch(url, { headers: FT_SCRAPE_HDR, signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const html = await r.text();
      const m = html.match(/<th>Ongoing charge<\/th><td>([\d.]+)%<\/td>/i)
             || html.match(/<th>Max annual charge<\/th><td>([\d.]+)%<\/td>/i);
      if (m) return parseFloat(m[1]);
    } catch (_) {}
  }
  // Fallback: Morningstar screener (covers ETFs and funds not found on FT Markets)
  try {
    const MSTAR_HDR = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://www.morningstar.es/' };
    const mstarUrl = `https://tools.morningstar.es/api/rest.svc/9vehuxllxs/security/screener?page=1&pageSize=3&sortOrder=LegalName+asc&outputType=json&version=1&languageId=es-ES&currencyId=EUR&securityDataPoints=SecId,LegalName,OngoingCharge&term=${encodeURIComponent(isin)}`;
    const mr = await fetch(mstarUrl, { headers: MSTAR_HDR, signal: AbortSignal.timeout(8000) });
    if (mr.ok) {
      const mdata = await mr.json();
      const rows = mdata?.rows ?? mdata?.data ?? [];
      if (rows.length && rows[0].OngoingCharge != null) return parseFloat(rows[0].OngoingCharge);
    }
  } catch (_) {}
  return null;
}

// Ensure ter cache table exists (runs once on startup)
pool.query(`CREATE TABLE IF NOT EXISTS asset_ter_cache (
  isin VARCHAR(20) PRIMARY KEY,
  ter DECIMAL(6,4) NOT NULL,
  source VARCHAR(30) DEFAULT 'ft_markets',
  fetched_at DATETIME DEFAULT NOW(),
  valid_until DATETIME NOT NULL,
  INDEX idx_valid (valid_until)
)`).catch(() => {});

app.get('/api/ter/fetch', async (req, res) => {
  const rawIsins = String(req.query?.isin || '');
  const isins = rawIsins.split(',').map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{2}[A-Z0-9]{8,10}$/.test(s)).slice(0, 60);
  if (!isins.length) return res.status(400).json({ error: 'isin required' });

  const results = {};

  // Check DB cache first
  const placeholders = isins.map(() => '?').join(',');
  const [cached] = await pool.query(
    `SELECT isin, ter FROM asset_ter_cache WHERE isin IN (${placeholders}) AND valid_until > NOW()`,
    isins
  ).catch(() => [[]]);
  for (const row of cached) results[row.isin] = parseFloat(row.ter);

  // Fetch missing from FT Markets in parallel
  const missing = isins.filter(i => results[i] == null);
  if (missing.length) {
    const nextYear = new Date(); nextYear.setFullYear(nextYear.getFullYear() + 1);
    await Promise.all(missing.map(async isin => {
      const ter = await scrapeFTMarketsTER(isin);
      if (ter != null) {
        results[isin] = ter;
        await pool.query(
          'INSERT INTO asset_ter_cache (isin, ter, source, fetched_at, valid_until) VALUES (?,?,?,NOW(),?) ON DUPLICATE KEY UPDATE ter=VALUES(ter), fetched_at=NOW(), valid_until=VALUES(valid_until)',
          [isin, ter, 'ft_markets', nextYear]
        ).catch(() => {});
      }
    }));
  }

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ results });
});

// ── Serve main app HTML pages with no-cache headers ──────────────────────────
// Serve /mobile and /desktop through Node.js with proper Cache-Control.
const WEBAPP_HTML = process.env.WEBAPP_HTML || (process.env.NODE_ENV === 'production' ? '.' : '/home/runcloud/webapps/finasset');
const NO_CACHE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache' };
for (const page of ['mobile', 'desktop']) {
  app.get('/' + page, (req, res) => {
    Object.entries(NO_CACHE).forEach(([k,v]) => res.setHeader(k, v));
    res.sendFile(WEBAPP_HTML + '/' + page + '.html', err => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
}

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '127.0.0.1', () => {
    console.log('[finasset-api] Listening on port ' + PORT);
  });
}

// Export for Vercel serverless
module.exports = app;
