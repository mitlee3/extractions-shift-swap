const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const cookieSession = require('cookie-session');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_URL', 'SESSION_SECRET'];
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const oauthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.OAUTH_REDIRECT_URL,
);
const db = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  })
  : null;

if (db) db.on('error', (err) => console.error('Unexpected PostgreSQL pool error:', err));

// Cloud Run terminates TLS before forwarding requests to the container.
if (isProduction) app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET],
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
}));

// Public assets (CSS, JS, images)
app.use('/assets', express.static(path.join(__dirname, 'public')));

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function requireUser(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requireDatabase(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database is not configured' });
  next();
}

app.get('/dashboard', requireUser, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/', (req, res) => {
  res.type('html').send(req.session.user
    ? `<main><h1>Signed in</h1><p>${escapeHtml(req.session.user.email)}</p><p><a href="/logout">Sign out</a></p></main>`
    : '<main><h1>Shift Swap</h1><p>Use your Gmail or natera.com account.</p><p><a href="/auth/google">Sign in with Google</a></p></main>');
});

app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  req.session.oauthNonce = nonce;

  const url = oauthClient.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
    nonce,
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(401).send('Google sign-in was not completed.');
    if (typeof code !== 'string' || typeof state !== 'string' || !req.session.oauthState ||
        !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(req.session.oauthState))) {
      return res.status(400).send('Invalid OAuth state. Please try signing in again.');
    }

    const expectedNonce = req.session.oauthNonce;
    delete req.session.oauthState;
    delete req.session.oauthNonce;

    const { tokens } = await oauthClient.getToken(code);
    if (!tokens.id_token) return res.status(401).send('Google did not return an ID token.');

    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const profile = ticket.getPayload();
    if (!profile || profile.nonce !== expectedNonce || !profile.email_verified ||
        !profile.email ||
        (!profile.email.toLowerCase().endsWith('@gmail.com') &&
         !profile.email.toLowerCase().endsWith('@natera.com'))) {
      return res.status(403).send('Use a verified Gmail or natera.com account to sign in.');
    }

    req.session.user = {
      id: profile.sub,
      email: profile.email,
      name: profile.name || profile.email,
      picture: profile.picture || null,
    };

    return res.redirect('/dashboard');
  } catch (err) {
    return next(err);
  }
});

app.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Sign-in required' });
  res.json(req.session.user);
});

app.get('/api/shift-requests', requireUser, requireDatabase, async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT
        swap.id,
        swap.status,
        swap.submitted_at,
        swap.person_requesting_off,
        swap.person_requesting_on,
        requester.first_name || ' ' || requester.last_name AS requester_name,
        offering.first_name || ' ' || offering.last_name AS offering_name
      FROM "ShiftSwaps" AS swap
      JOIN "User" AS requester ON requester.id = swap.person_requesting
      LEFT JOIN "User" AS offering ON offering.id = swap.person_offering
      ORDER BY swap.submitted_at DESC NULLS LAST, swap.id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

app.use((err, req, res, next) => {
  console.error('Request failed:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Request failed. Please try again later.');
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Listening on ${port}`));

process.on('SIGTERM', () => {
  if (db) db.end().catch((err) => console.error('Error closing PostgreSQL pool:', err));
});
