// Load Node.js utilities used for OAuth state, file paths, and database certificates.
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// Load Express, signed-cookie sessions, Google OAuth, and PostgreSQL support.
const express = require('express');
const cookieSession = require('cookie-session');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');

// Fail at startup if any required authentication or session setting is missing.
const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_URL', 'SESSION_SECRET'];
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

// Return values matching database constraints: positions CLA/CLS/CORE and shifts 1/2/3.
const profileOptions = {
  positions: ['CLA', 'CLS', 'CORE'],
  shiftNumbers: ['1', '2', '3'],
  // UserScheduleDays uses SMALLINT weekday values, with Sunday = 0.
  shiftDays: [
    { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
  ],
};

// Create the application, OAuth client, and TLS-verified PostgreSQL connection pool.
const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const oauthClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.OAUTH_REDIRECT_URL);
const db = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: { rejectUnauthorized: true, ca: fs.readFileSync(path.join(__dirname, 'certs', 'ca.pem'), 'utf8') },
}) : null;

if (db) db.on('error', (err) => console.error('Unexpected PostgreSQL pool error:', err));
if (isProduction) app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({
  name: 'session', keys: [process.env.SESSION_SECRET], httpOnly: true,
  secure: isProduction, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000,
}));
app.use('/assets', express.static(path.join(__dirname, 'public')));

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
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
function userFromRow(row, picture = null) {
  return {
    id: row.id, email: row.email, name: `${row.first_name} ${row.last_name}`.trim(), picture,
    profileComplete: Boolean(row.schedule_id), position: row.position,
    shiftNumber: row.shift_number, scheduleId: row.schedule_id || null,
  };
}

app.get('/dashboard', requireProfile, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/profile', requireUser, (req, res) => {
  if (req.session.user.profileComplete) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.profileComplete ? '/dashboard' : '/profile');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Shift Swap</title><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main class="welcome"><div class="welcome-card"><p class="section-kicker">Extraction team</p><h1>Shift Swap</h1><p>Use your verified Gmail or natera.com account.</p><a class="primary-btn" href="/auth/google">Sign in with Google</a></div></main></body></html>`);
});

app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  req.session.oauthNonce = nonce;
  res.redirect(oauthClient.generateAuthUrl({ access_type: 'online', prompt: 'select_account', scope: ['openid', 'email', 'profile'], state, nonce }));
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(401).send('Google sign-in was not completed.');
    if (typeof code !== 'string' || typeof state !== 'string' || !req.session.oauthState || !safeTokenEqual(state, req.session.oauthState)) {
      return res.status(400).send('Invalid OAuth state. Please try signing in again.');
    }
    const expectedNonce = req.session.oauthNonce;
    delete req.session.oauthState;
    delete req.session.oauthNonce;
    const { tokens } = await oauthClient.getToken(code);
    if (!tokens.id_token) return res.status(401).send('Google did not return an ID token.');
    const ticket = await oauthClient.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
    const profile = ticket.getPayload();
    const email = profile?.email?.toLowerCase() || '';
    if (!profile || profile.nonce !== expectedNonce || !profile.email_verified || (!email.endsWith('@gmail.com') && !email.endsWith('@natera.com'))) {
      return res.status(403).send('Use a verified Gmail or natera.com account to sign in.');
    }
    if (!db) return res.status(503).send('Database is not configured. Please contact the app administrator.');
    const result = await db.query(`
      SELECT u.id, u.email, u.first_name, u.last_name, u.position, u.shift_number, c.schedule_id
      FROM "User" u LEFT JOIN "UserScheduleCurrent" c ON c.user_id = u.id
      WHERE lower(u.email) = lower($1) LIMIT 1
    `, [profile.email]);
    if (result.rows[0]) {
      req.session.user = userFromRow(result.rows[0], profile.picture || null);
      return res.redirect(req.session.user.profileComplete ? '/dashboard' : '/profile');
    }
    const [fallbackFirstName, ...rest] = (profile.name || '').trim().split(/\s+/).filter(Boolean);
    req.session.user = {
      id: null, email: profile.email, name: profile.name || profile.email, picture: profile.picture || null,
      profileComplete: false, suggestedFirstName: profile.given_name || fallbackFirstName || '',
      suggestedLastName: profile.family_name || rest.join(' '),
    };
    return res.redirect('/profile');
  } catch (err) { return next(err); }
});

app.get('/api/profile-options', requireUser, (req, res) => {
  if (req.session.user.profileComplete) return res.status(409).json({ error: 'Profile is already complete' });
  if (!req.session.profileCsrfToken) req.session.profileCsrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ csrfToken: req.session.profileCsrfToken, firstName: req.session.user.suggestedFirstName || '', lastName: req.session.user.suggestedLastName || '', options: profileOptions });
});

app.post('/api/profile', requireUser, requireDatabase, async (req, res, next) => {
  if (req.session.user.profileComplete) return res.status(409).json({ error: 'Profile is already complete' });
  if (!safeTokenEqual(req.body.csrfToken, req.session.profileCsrfToken)) return res.status(403).json({ error: 'Invalid form token. Reload the page and try again.' });
  const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
  const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
  const position = req.body.position;
  const shiftNumber = req.body.shiftNumber;
  const shiftDays = Array.isArray(req.body.shiftDays) ? req.body.shiftDays.map(Number) : [];
  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) return res.status(400).json({ error: 'Enter a first and last name (up to 100 characters each).' });
  if (!profileOptions.positions.includes(position) || !profileOptions.shiftNumbers.includes(shiftNumber) || !shiftDays.length || shiftDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(shiftDays).size !== shiftDays.length) {
    return res.status(400).json({ error: 'Choose a valid position, shift number, and at least one shift day.' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended(lower($1), 0))', [req.session.user.email]);
    const existing = await client.query('SELECT id, email, first_name, last_name, position, shift_number FROM "User" WHERE lower(email) = lower($1) LIMIT 1', [req.session.user.email]);
    let row = existing.rows[0];
    if (!row) {
      const inserted = await client.query(`INSERT INTO "User" (first_name, last_name, email, position, shift_number) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, first_name, last_name, position, shift_number`, [firstName, lastName, req.session.user.email, position, shiftNumber]);
      row = inserted.rows[0];
    }
    const schedule = await client.query('INSERT INTO "UserScheduleHistory" (user_id) VALUES ($1) RETURNING schedule_id', [row.id]);
    const scheduleId = schedule.rows[0].schedule_id;
    for (const day of shiftDays) await client.query('INSERT INTO "UserScheduleDays" (schedule_id, day_of_week) VALUES ($1, $2)', [scheduleId, day]);
    await client.query(`INSERT INTO "UserScheduleCurrent" (user_id, schedule_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET schedule_id = EXCLUDED.schedule_id, created_at = CURRENT_TIMESTAMP`, [row.id, scheduleId]);
    await client.query('COMMIT');
    row.schedule_id = scheduleId;
    req.session.user = userFromRow(row, req.session.user.picture || null);
    delete req.session.profileCsrfToken;
    return res.json({ redirect: '/dashboard' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return next(err);
  } finally { client.release(); }
});

app.get('/me', requireUser, (req, res) => res.json(req.session.user));
app.get('/api/shift-requests', requireProfile, requireDatabase, async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT r.id, r.person_requesting_on, NULL::date AS person_offering_on, r.request_opened_at AS submitted_at,
             requester.first_name || ' ' || requester.last_name AS requester_name, NULL::text AS offering_name, 'Open' AS status
      FROM "ShiftSwapsOpen" r JOIN "User" requester ON requester.id = r.person_requesting
      UNION ALL
      SELECT h.id, h.person_requesting_on, h.person_offering_on, h.submitted_at,
             requester.first_name || ' ' || requester.last_name AS requester_name,
             offering.first_name || ' ' || offering.last_name AS offering_name, h.status
      FROM "ShiftSwapsHistory" h JOIN "User" requester ON requester.id = h.person_requesting
      JOIN "User" offering ON offering.id = h.person_offering
      ORDER BY submitted_at DESC NULLS LAST, id DESC
    `);
    res.json(result.rows);
  } catch (err) { next(err); }
});
app.post('/api/shift-requests', requireProfile, requireDatabase, async (req, res, next) => {
  const date = typeof req.body.date === 'string' ? req.body.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Choose a valid date.' });
  try {
    const result = await db.query(`INSERT INTO "ShiftSwapsOpen" (person_requesting, requester_schedule_id, person_requesting_on) VALUES ($1, $2, $3) RETURNING id, person_requesting_on, request_opened_at`, [req.session.user.id, req.session.user.scheduleId, date]);
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});
app.post('/api/shift-requests/:id/offers', requireProfile, requireDatabase, async (req, res, next) => {
  const requestId = Number(req.params.id);
  const date = typeof req.body.date === 'string' ? req.body.date : '';
  if (!Number.isInteger(requestId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Choose a valid request and date.' });
  try {
    const result = await db.query(`INSERT INTO "ShiftOffers" (corresponding_request_id, person_offering, offering_schedule_id, person_offering_on) VALUES ($1, $2, $3, $4) RETURNING id`, [requestId, req.session.user.id, req.session.user.scheduleId, date]);
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});
app.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });
app.get('/logout', (req, res) => { req.session = null; res.redirect('/'); });
app.use((err, req, res, next) => {
  console.error('Request failed:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('Request failed. Please try again later.');
});
const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log(`Listening on ${port}`));
process.on('SIGTERM', () => { if (db) db.end().catch((err) => console.error('Error closing PostgreSQL pool:', err)); });
