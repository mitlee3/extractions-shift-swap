// Load Node.js utilities used for OAuth state, file paths, and database certificates.
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

const profileOptions = {
  positions: ['CLA', 'CLS', 'CORE'],
  shiftNumbers: ['1', '2', '3'],
  shiftDays: [
    { value: 0, label: 'Monday' }, { value: 1, label: 'Tuesday' },
    { value: 2, label: 'Wednesday' }, { value: 3, label: 'Thursday' },
    { value: 4, label: 'Friday' }, { value: 5, label: 'Saturday' },
    { value: 6, label: 'Sunday' },
  ],
};

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
    id: row.id,
    email: row.email,
    name: `${row.first_name} ${row.last_name}`.trim(),
    picture,
    profileComplete: Boolean(row.schedule_id),
    position: row.position || null,
    shiftNumber: row.shift_number || null,
    scheduleId: row.schedule_id || null,
  };
}
function currentUserSelect(whereClause) {
  return `
    SELECT u.id, u.email, u.first_name, u.last_name, u.profile_updated_at,
           h.position, h.shift_number, c.schedule_id
    FROM "User" u
    LEFT JOIN "UserScheduleCurrent" c ON c.user_id = u.id
    LEFT JOIN "UserScheduleHistory" h
      ON h.schedule_id = c.schedule_id AND h.user_id = c.user_id
    ${whereClause}
  `;
}

app.get('/dashboard', requireProfile, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/profile', requireUser, (req, res) => {
  if (req.session.user.profileComplete) return res.redirect('/settings');
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});
app.get('/settings', requireProfile, (req, res) => res.sendFile(path.join(__dirname, 'views', 'settings.html')));
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.profileComplete ? '/dashboard' : '/profile');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Shift Swap</title><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main class="welcome"><section class="welcome-card"><p class="section-kicker">Extraction operations</p><h1>Shift Swap</h1><p>Sign in to manage your shift swap profile and requests.</p><a class="primary-btn" href="/auth/google">Sign in with Google</a></section></main></body></html>`);
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
    const result = await db.query(`${currentUserSelect('WHERE lower(u.email) = lower($1) LIMIT 1')}`, [email]);
    if (result.rows[0]) {
      req.session.user = userFromRow(result.rows[0], profile.picture || null);
      return res.redirect(req.session.user.profileComplete ? '/dashboard' : '/profile');
    }
    const [fallbackFirstName, ...rest] = (profile.name || '').trim().split(/\s+/).filter(Boolean);
    req.session.user = {
      id: null, email, name: profile.name || email, picture: profile.picture || null,
      profileComplete: false, suggestedFirstName: profile.given_name || fallbackFirstName || '',
      suggestedLastName: profile.family_name || rest.join(' '),
    };
    return res.redirect('/profile');
  } catch (err) { return next(err); }
});

app.get('/api/profile-options', requireUser, (req, res) => {
  if (req.session.user.profileComplete) return res.status(409).json({ error: 'Use profile settings to update your profile' });
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
  if (!profileOptions.positions.includes(position) || !profileOptions.shiftNumbers.includes(shiftNumber) || !shiftDays.length || shiftDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(shiftDays).size !== shiftDays.length) return res.status(400).json({ error: 'Choose a valid position, shift number, and at least one shift day.' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended(lower($1), 0))', [req.session.user.email]);
    const existing = await client.query(`${currentUserSelect('WHERE lower(u.email) = lower($1) LIMIT 1')}`, [req.session.user.email]);
    let row = existing.rows[0];
    if (row?.schedule_id) { await client.query('ROLLBACK'); req.session.user = userFromRow(row, req.session.user.picture || null); return res.status(409).json({ error: 'Profile is already complete' }); }
    if (!row) {
      const inserted = await client.query('INSERT INTO "User" (first_name, last_name, email, profile_updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING id, email, first_name, last_name, profile_updated_at', [firstName, lastName, req.session.user.email]);
      row = inserted.rows[0];
    } else {
      const updated = await client.query('UPDATE "User" SET first_name = $2, last_name = $3, profile_updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, email, first_name, last_name, profile_updated_at', [row.id, firstName, lastName]);
      row = updated.rows[0];
    }
    const schedule = await client.query('INSERT INTO "UserScheduleHistory" (user_id, shift_number, position) VALUES ($1, $2, $3) RETURNING schedule_id', [row.id, shiftNumber, position]);
    const scheduleId = schedule.rows[0].schedule_id;
    for (const day of shiftDays) await client.query('INSERT INTO "UserScheduleDays" (schedule_id, day_of_week) VALUES ($1, $2)', [scheduleId, day]);
    await client.query('INSERT INTO "UserScheduleCurrent" (user_id, schedule_id) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET schedule_id = EXCLUDED.schedule_id, created_at = CURRENT_TIMESTAMP', [row.id, scheduleId]);
    await client.query('COMMIT');
    row.schedule_id = scheduleId; row.position = position; row.shift_number = shiftNumber;
    req.session.user = userFromRow(row, req.session.user.picture || null);
    delete req.session.profileCsrfToken;
    return res.json({ redirect: '/dashboard' });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); return next(err); } finally { client.release(); }
});

app.get('/api/profile-settings', requireProfile, requireDatabase, async (req, res, next) => {
  try {
    if (!req.session.profileUpdateCsrfToken) req.session.profileUpdateCsrfToken = crypto.randomBytes(32).toString('hex');
    const userResult = await db.query(`${currentUserSelect('WHERE u.id = $1 LIMIT 1')}`, [req.session.user.id]);
    const row = userResult.rows[0];
    if (!row) return res.status(404).json({ error: 'Profile not found' });
    const daysResult = await db.query('SELECT day_of_week FROM "UserScheduleDays" WHERE schedule_id = $1 ORDER BY day_of_week', [row.schedule_id]);
    const lastUpdated = row.profile_updated_at ? new Date(row.profile_updated_at) : null;
    const scheduleUpdated = row.profile_updated_at ? null : null;
    const fallbackResult = row.profile_updated_at ? null : await db.query('SELECT created_at FROM "UserScheduleHistory" WHERE schedule_id = $1 AND user_id = $2', [row.schedule_id, row.id]);
    const fallbackDate = fallbackResult?.rows[0]?.created_at ? new Date(fallbackResult.rows[0].created_at) : null;
    const lastUpdateDate = lastUpdated || fallbackDate;
    const nextUpdateDate = lastUpdateDate ? new Date(lastUpdateDate.getTime() + 30 * 24 * 60 * 60 * 1000) : null;
    const canUpdate = !nextUpdateDate || nextUpdateDate.getTime() <= Date.now();
    res.json({ csrfToken: req.session.profileUpdateCsrfToken, firstName: row.first_name, lastName: row.last_name, position: row.position, shiftNumber: row.shift_number, shiftDays: daysResult.rows.map((item) => item.day_of_week), options: profileOptions, canUpdate, nextUpdateDate: nextUpdateDate?.toISOString() || null });
  } catch (err) { next(err); }
});

app.post('/api/profile-settings', requireProfile, requireDatabase, async (req, res, next) => {
  if (!safeTokenEqual(req.body.csrfToken, req.session.profileUpdateCsrfToken)) return res.status(403).json({ error: 'Invalid form token. Reload the page and try again.' });
  const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
  const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
  const position = req.body.position;
  const shiftNumber = req.body.shiftNumber;
  const shiftDays = Array.isArray(req.body.shiftDays) ? [...new Set(req.body.shiftDays.map(Number))].sort((a, b) => a - b) : [];
  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) return res.status(400).json({ error: 'Enter a first and last name (up to 100 characters each).' });
  if (!profileOptions.positions.includes(position) || !profileOptions.shiftNumbers.includes(shiftNumber) || !shiftDays.length || shiftDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return res.status(400).json({ error: 'Choose a valid position, shift number, and at least one shift day.' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [req.session.user.id]);
    const current = await client.query(`${currentUserSelect('WHERE u.id = $1 LIMIT 1')}`, [req.session.user.id]);
    const row = current.rows[0];
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Profile not found' }); }
    const daysResult = await client.query('SELECT day_of_week FROM "UserScheduleDays" WHERE schedule_id = $1 ORDER BY day_of_week', [row.schedule_id]);
    const oldDays = daysResult.rows.map((item) => item.day_of_week);
    const fallbackResult = row.profile_updated_at ? null : await client.query('SELECT created_at FROM "UserScheduleHistory" WHERE schedule_id = $1 AND user_id = $2', [row.schedule_id, row.id]);
    const lastUpdateDate = row.profile_updated_at ? new Date(row.profile_updated_at) : fallbackResult?.rows[0]?.created_at ? new Date(fallbackResult.rows[0].created_at) : null;
    const nextUpdateDate = lastUpdateDate ? new Date(lastUpdateDate.getTime() + 30 * 24 * 60 * 60 * 1000) : null;
    if (nextUpdateDate && nextUpdateDate.getTime() > Date.now()) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Profile updates are available again ${nextUpdateDate.toLocaleDateString()}.`, nextUpdateDate: nextUpdateDate.toISOString() }); }

    await client.query('UPDATE "User" SET first_name = $2, last_name = $3, profile_updated_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id, firstName, lastName]);
    const scheduleChanged = row.position !== position || row.shift_number !== shiftNumber || JSON.stringify(oldDays) !== JSON.stringify(shiftDays);
    if (scheduleChanged) {
      const schedule = await client.query('INSERT INTO "UserScheduleHistory" (user_id, shift_number, position) VALUES ($1, $2, $3) RETURNING schedule_id', [row.id, shiftNumber, position]);
      const scheduleId = schedule.rows[0].schedule_id;
      for (const day of shiftDays) await client.query('INSERT INTO "UserScheduleDays" (schedule_id, day_of_week) VALUES ($1, $2)', [scheduleId, day]);
      await client.query('UPDATE "UserScheduleCurrent" SET schedule_id = $2, created_at = CURRENT_TIMESTAMP WHERE user_id = $1', [row.id, scheduleId]);
    }
    await client.query('COMMIT');
    req.session.user = { ...req.session.user, name: `${firstName} ${lastName}`.trim(), position, shiftNumber };
    delete req.session.profileUpdateCsrfToken;
    return res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); return next(err); } finally { client.release(); }
});

app.get('/me', requireUser, (req, res) => res.json(req.session.user));
app.get('/api/shift-requests', requireProfile, requireDatabase, async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT r.id, r.person_requesting_on, NULL::date AS person_offering_on, r.request_opened_at AS submitted_at,
             requester.first_name || ' ' || requester.last_name AS requester_name,
             NULL::text AS offering_name, 'Open' AS status
      FROM "ShiftSwapsOpen" r JOIN "User" requester ON requester.id = r.person_requesting
      UNION ALL
      SELECT h.id, h.person_requesting_on, h.person_offering_on, h.submitted_at,
             requester.first_name || ' ' || requester.last_name AS requester_name,
             offering.first_name || ' ' || offering.last_name AS offering_name, h.status
      FROM "ShiftSwapsHistory" h
      JOIN "User" requester ON requester.id = h.person_requesting
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
    const result = await db.query('INSERT INTO "ShiftSwapsOpen" (person_requesting, requester_schedule_id, person_requesting_on) VALUES ($1, $2, $3) RETURNING id, person_requesting_on, request_opened_at', [req.session.user.id, req.session.user.scheduleId, date]);
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});
app.post('/api/shift-requests/:id/offers', requireProfile, requireDatabase, async (req, res, next) => {
  const requestId = Number(req.params.id);
  const date = typeof req.body.date === 'string' ? req.body.date : '';
  if (!Number.isInteger(requestId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Choose a valid request and date.' });
  try {
    const result = await db.query('INSERT INTO "ShiftOffers" (corresponding_request_id, person_offering, offering_schedule_id, person_offering_on) VALUES ($1, $2, $3, $4) RETURNING id', [requestId, req.session.user.id, req.session.user.scheduleId, date]);
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

async function start() {
  if (db) {
    await db.query('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ');
  }
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, '0.0.0.0', () => console.log(`Listening on ${port}`));
}
start().catch((err) => { console.error('Failed to start application:', err); process.exit(1); });
process.on('SIGTERM', () => { if (db) db.end().catch((err) => console.error('Error closing PostgreSQL pool:', err)); });
