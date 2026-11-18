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

// Values match the current schema: Monday = 0, Sunday = 6.
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
const oauthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.OAUTH_REDIRECT_URL,
);
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
    position: row.position,
    shiftNumber: row.shift_number,
    scheduleId: row.schedule_id || null,
  };
}

// Load profile identity and active schedule data using the normalized current schema.
async function findUser(email) {
  const result = await db.query(`
    SELECT u.id, u.email, u.first_name, u.last_name,
           h.position, h.shift_number, c.schedule_id,
           COALESCE(array_agg(d.day_of_week ORDER BY d.day_of_week)
             FILTER (WHERE d.day_of_week IS NOT NULL), ARRAY[]::smallint[]) AS shift_days
    FROM "User" u
    LEFT JOIN "UserScheduleCurrent" c ON c.user_id = u.id
    LEFT JOIN "UserScheduleHistory" h ON h.schedule_id = c.schedule_id AND h.user_id = u.id
    LEFT JOIN "UserScheduleDays" d ON d.schedule_id = c.schedule_id
    WHERE lower(u.email) = lower($1)
    GROUP BY u.id, c.schedule_id, h.position, h.shift_number
    LIMIT 1
  `, [email]);
  return result.rows[0] || null;
}

app.get('/dashboard', requireProfile, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});
app.get('/profile', requireUser, (req, res) => {
  if (req.session.user.profileComplete) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});
app.get('/profile/update', requireProfile, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.profileComplete ? '/dashboard' : '/profile');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shift Swap</title><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main class="welcome"><div class="welcome-card"><p class="section-kicker">Extraction team</p><h1>Shift Swap</h1><p>Use your verified Gmail or natera.com account.</p><a class="primary-btn" href="/auth/google">Sign in with Google</a></div></main></body></html>`);
});

app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  req.session.oauthNonce = nonce;
  res.redirect(oauthClient.generateAuthUrl({
    access_type: 'online', prompt: 'select_account', scope: ['openid', 'email', 'profile'], state, nonce,
  }));
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(401).send('Google sign-in was not completed.');
    if (typeof code !== 'string' || typeof state !== 'string' ||
        !req.session.oauthState || !safeTokenEqual(state, req.session.oauthState)) {
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
    if (!profile || profile.nonce !== expectedNonce || !profile.email_verified ||
        (!email.endsWith('@gmail.com') && !email.endsWith('@natera.com'))) {
      return res.status(403).send('Use a verified Gmail or natera.com account to sign in.');
    }
    if (!db) return res.status(503).send('Database is not configured. Please contact the app administrator.');

    const row = await findUser(profile.email);
    if (row) {
      req.session.user = userFromRow(row, profile.picture || null);
      return res.redirect(req.session.user.profileComplete ? '/dashboard' : '/profile');
    }
    const [fallbackFirstName, ...rest] = (profile.name || '').trim().split(/\s+/).filter(Boolean);
    req.session.user = {
      id: null, email: profile.email, name: profile.name || profile.email,
      picture: profile.picture || null, profileComplete: false,
      suggestedFirstName: profile.given_name || fallbackFirstName || '',
      suggestedLastName: profile.family_name || rest.join(' '),
    };
    return res.redirect('/profile');
  } catch (err) { return next(err); }
});

function ensureProfileCsrf(req) {
  if (!req.session.profileCsrfToken) req.session.profileCsrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.profileCsrfToken;
}
app.get('/api/profile-options', requireUser, requireDatabase, async (req, res, next) => {
  try {
    if (req.session.user.profileComplete) return res.status(409).json({ error: 'Profile is already complete' });
    const existing = await findUser(req.session.user.email);
    res.json({
      csrfToken: ensureProfileCsrf(req),
      firstName: existing?.first_name || req.session.user.suggestedFirstName || '',
      lastName: existing?.last_name || req.session.user.suggestedLastName || '',
      position: existing?.position || '', shiftNumber: existing?.shift_number || '',
      shiftDays: existing?.shift_days || [], options: profileOptions,
    });
  } catch (err) { next(err); }
});

// The newest history timestamp controls both the displayed availability and server-side enforcement.
app.get('/api/profile-update', requireProfile, requireDatabase, async (req, res, next) => {
  try {
    const result = await db.query(`
      SELECT u.first_name, u.last_name, h.position, h.shift_number, h.schedule_id,
             COALESCE(array_agg(d.day_of_week ORDER BY d.day_of_week)
               FILTER (WHERE d.day_of_week IS NOT NULL), ARRAY[]::smallint[]) AS shift_days,
             latest.created_at + INTERVAL '1 month' AS available_at,
             CURRENT_TIMESTAMP >= latest.created_at + INTERVAL '1 month' AS can_update
      FROM "User" u
      JOIN "UserScheduleCurrent" c ON c.user_id = u.id
      JOIN "UserScheduleHistory" h ON h.schedule_id = c.schedule_id AND h.user_id = u.id
      JOIN LATERAL (
        SELECT created_at FROM "UserScheduleHistory"
        WHERE user_id = u.id ORDER BY created_at DESC, schedule_id DESC LIMIT 1
      ) latest ON true
      LEFT JOIN "UserScheduleDays" d ON d.schedule_id = h.schedule_id
      WHERE u.id = $1
      GROUP BY u.id, h.schedule_id, h.position, h.shift_number, latest.created_at
    `, [req.session.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Profile not found.' });
    const row = result.rows[0];
    res.json({
      csrfToken: ensureProfileCsrf(req), firstName: row.first_name, lastName: row.last_name,
      position: row.position, shiftNumber: row.shift_number, shiftDays: row.shift_days,
      canUpdate: row.can_update, availableAt: row.available_at, options: profileOptions,
    });
  } catch (err) { next(err); }
});

function validateProfile(body) {
  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const position = body.position;
  const shiftNumber = body.shiftNumber;
  const shiftDays = Array.isArray(body.shiftDays) ? body.shiftDays.map(Number) : [];
  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
    return { error: 'Enter a first and last name (up to 100 characters each).' };
  }
  if (!profileOptions.positions.includes(position) || !profileOptions.shiftNumbers.includes(shiftNumber) ||
      !shiftDays.length || shiftDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(shiftDays).size !== shiftDays.length) {
    return { error: 'Choose a valid position, shift number, and at least one shift day.' };
  }
  return { firstName, lastName, position, shiftNumber, shiftDays };
}

// Initial profile creation and monthly edits append schedule history rather than overwriting it.
app.post('/api/profile', requireUser, requireDatabase, async (req, res, next) => {
  if (!safeTokenEqual(req.body.csrfToken, req.session.profileCsrfToken)) {
    return res.status(403).json({ error: 'Invalid form token. Reload the page and try again.' });
  }
  const profile = validateProfile(req.body);
  if (profile.error) return res.status(400).json({ error: profile.error });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent edits/registrations for this account.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended(lower($1), 0))', [req.session.user.email]);
    const existing = await client.query(
      'SELECT id, email, first_name, last_name FROM "User" WHERE lower(email) = lower($1) LIMIT 1',
      [req.session.user.email],
    );
    let user = existing.rows[0];
    if (!user) {
      const created = await client.query(`
        INSERT INTO "User" (first_name, last_name, email) VALUES ($1, $2, $3)
        RETURNING id, email, first_name, last_name
      `, [profile.firstName, profile.lastName, req.session.user.email]);
      user = created.rows[0];
    }

    const current = await client.query(
      'SELECT schedule_id FROM "UserScheduleCurrent" WHERE user_id = $1 FOR UPDATE', [user.id],
    );
    const isUpdate = current.rowCount > 0;
    if (isUpdate) {
      const latest = await client.query(`
        SELECT created_at + INTERVAL '1 month' AS available_at,
               CURRENT_TIMESTAMP >= created_at + INTERVAL '1 month' AS can_update
        FROM "UserScheduleHistory" WHERE user_id = $1
        ORDER BY created_at DESC, schedule_id DESC LIMIT 1
      `, [user.id]);
      if (!latest.rows[0]?.can_update) {
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: 'You can update your profile once a month. You can make your next update on the date shown below.',
          availableAt: latest.rows[0]?.available_at || null,
        });
      }
      await client.query('UPDATE "User" SET first_name = $1, last_name = $2 WHERE id = $3', [profile.firstName, profile.lastName, user.id]);
    }

    const history = await client.query(`
      INSERT INTO "UserScheduleHistory" (user_id, shift_number, position)
      VALUES ($1, $2, $3) RETURNING schedule_id
    `, [user.id, profile.shiftNumber, profile.position]);
    const scheduleId = history.rows[0].schedule_id;
    for (const day of profile.shiftDays) {
      await client.query('INSERT INTO "UserScheduleDays" (schedule_id, day_of_week) VALUES ($1, $2)', [scheduleId, day]);
    }
    await client.query(`
      INSERT INTO "UserScheduleCurrent" (user_id, schedule_id) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE
      SET schedule_id = EXCLUDED.schedule_id, created_at = CURRENT_TIMESTAMP
    `, [user.id, scheduleId]);
    await client.query('COMMIT');

    const updatedUser = await findUser(req.session.user.email);
    req.session.user = userFromRow(updatedUser, req.session.user.picture || null);
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
      SELECT r.id, r.person_requesting_on, NULL::date AS person_offering_on,
             r.request_opened_at AS submitted_at,
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
    const result = await db.query(`
      INSERT INTO "ShiftSwapsOpen" (person_requesting, requester_schedule_id, person_requesting_on)
      VALUES ($1, $2, $3) RETURNING id, person_requesting_on, request_opened_at
    `, [req.session.user.id, req.session.user.scheduleId, date]);
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});
app.post('/api/shift-requests/:id/offers', requireProfile, requireDatabase, async (req, res, next) => {
  const requestId = Number(req.params.id);
  const date = typeof req.body.date === 'string' ? req.body.date : '';
  if (!Number.isInteger(requestId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Choose a valid request and date.' });
  }
  try {
    const result = await db.query(`
      INSERT INTO "ShiftOffers" (corresponding_request_id, person_offering, offering_schedule_id, person_offering_on)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [requestId, req.session.user.id, req.session.user.scheduleId, date]);
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
process.on('SIGTERM', () => {
  if (db) db.end().catch((err) => console.error('Error closing PostgreSQL pool:', err));
});
