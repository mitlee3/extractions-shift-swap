const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cookieSession = require('cookie-session');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_URL', 'SESSION_SECRET'];
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

function configuredOptions(envName, defaults) {
  const configured = process.env[envName];
  return configured
    ? configured.split(',').map((value) => value.trim()).filter(Boolean)
    : defaults;
}

const profileOptions = {
  positions: configuredOptions('PROFILE_POSITIONS', ['Extractionist', 'Lead', 'Supervisor', 'Manager']),
  shiftNumbers: configuredOptions('PROFILE_SHIFT_NUMBERS', ['1', '2', '3']),
  shiftDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
};

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const oauthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.OAUTH_REDIRECT_URL,
);
// Connect to PostgreSQL over TLS and validate the server certificate using Aiven's CA certificate.
const db = process.env.DATABASE_URL
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.pem'), 'utf8'),
    },
  })
  : null;

if (db) db.on('error', (err) => console.error('Unexpected PostgreSQL pool error:', err));

// Cloud Run terminates TLS before forwarding requests to the container.
if (isProduction) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
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

function requireProfile(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  if (!req.session.user.profileComplete) return res.redirect('/profile');
  next();
}

function requireDatabase(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database is not configured' });
  next();
}

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function userFromRow(row, picture = null) {
  return {
    id: row.id,
    email: row.email,
    name: `${row.first_name} ${row.last_name}`.trim(),
    picture,
    profileComplete: true,
  };
}

app.get('/dashboard', requireProfile, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/profile', requireUser, (req, res) => {
  if (req.session.user.profileComplete) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.profileComplete ? '/dashboard' : '/profile');
  }
  return res.type('html').send('<main><h1>Shift Swap</h1><p>Use your Gmail or natera.com account.</p><p><a href="/auth/google">Sign in with Google</a></p></main>');
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
        !safeTokenEqual(state, req.session.oauthState)) {
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
    if (!db) return res.status(503).send('Database is not configured. Please contact the app administrator.');

    const result = await db.query(
      'SELECT id, email, first_name, last_name FROM "User" WHERE lower(email) = lower($1) LIMIT 1',
      [profile.email],
    );
    if (result.rows[0]) {
      req.session.user = userFromRow(result.rows[0], profile.picture || null);
      return res.redirect('/dashboard');
    }

    const [fallbackFirstName, ...fallbackLastNames] = (profile.name || '').trim().split(/\s+/).filter(Boolean);
    req.session.user = {
      id: null,
      email: profile.email,
      name: profile.name || profile.email,
      picture: profile.picture || null,
      profileComplete: false,
      suggestedFirstName: profile.given_name || fallbackFirstName || '',
      suggestedLastName: profile.family_name || fallbackLastNames.join(' '),
    };
    return res.redirect('/profile');
  } catch (err) {
    return next(err);
  }
});

app.get('/api/profile-options', requireUser, (req, res) => {
  if (req.session.user.profileComplete) return res.status(409).json({ error: 'Profile is already complete' });
  if (!req.session.profileCsrfToken) req.session.profileCsrfToken = crypto.randomBytes(32).toString('hex');
  res.json({
    csrfToken: req.session.profileCsrfToken,
    firstName: req.session.user.suggestedFirstName || '',
    lastName: req.session.user.suggestedLastName || '',
    options: profileOptions,
  });
});

app.post('/api/profile', requireUser, requireDatabase, async (req, res, next) => {
  if (req.session.user.profileComplete) return res.status(409).json({ error: 'Profile is already complete' });
  if (!safeTokenEqual(req.body.csrfToken, req.session.profileCsrfToken)) {
    return res.status(403).json({ error: 'Invalid form token. Reload the page and try again.' });
  }

  const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
  const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
  const position = req.body.position;
  const shiftNumber = req.body.shiftNumber;
  const shiftDays = Array.isArray(req.body.shiftDays) ? req.body.shiftDays : [req.body.shiftDays].filter(Boolean);

  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
    return res.status(400).json({ error: 'Enter a first and last name (up to 100 characters each).' });
  }
  if (!profileOptions.positions.includes(position) || !profileOptions.shiftNumbers.includes(shiftNumber) ||
      shiftDays.length === 0 || shiftDays.some((day) => !profileOptions.shiftDays.includes(day))) {
    return res.status(400).json({ error: 'Choose a valid position, shift number, and at least one shift day.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialize registrations for this email so concurrent sign-ins cannot create duplicate profiles.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended(lower($1), 0))', [req.session.user.email]);
    const existing = await client.query(
      'SELECT id, email, first_name, last_name FROM "User" WHERE lower(email) = lower($1) LIMIT 1',
      [req.session.user.email],
    );
    let row = existing.rows[0];
    if (!row) {
      const inserted = await client.query(
        `INSERT INTO "User" (first_name, last_name, email, position, shift_days, shift_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, first_name, last_name`,
        [firstName, lastName, req.session.user.email, position, shiftDays.join(', '), shiftNumber],
      );
      row = inserted.rows[0];
    }
    await client.query('COMMIT');
    req.session.user = userFromRow(row, req.session.user.picture || null);
    delete req.session.profileCsrfToken;
    return res.json({ redirect: '/dashboard' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

app.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Sign-in required' });
  res.json(req.session.user);
});

app.get('/api/shift-requests', requireProfile, requireDatabase, async (req, res, next) => {
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
