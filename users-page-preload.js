// Add the user-history page and its read-only API to the existing Express app.
// This preload keeps the feature isolated from the existing server routes while
// placing its middleware after the app's session middleware and before its routes.
const express = require('express');
const pg = require('pg');
const fs = require('node:fs');
const path = require('node:path');

let appInstance;
let poolInstance;

// Capture the app created by server.js without changing its normal Express API.
const expressFactory = function (...args) {
  const app = express(...args);
  appInstance = app;
  const originalGet = app.get.bind(app);
  let pageMiddlewareInstalled = false;

  app.get = function (route, ...handlers) {
    if (!pageMiddlewareInstalled && route === '/dashboard') {
      pageMiddlewareInstalled = true;
      app.use(async (req, res, next) => {
        if (!['/users', '/dashboard', '/settings'].includes(req.path)
          && !req.path.startsWith('/api/users/')) return next();
        if (!req.session?.user) return res.redirect('/');
        if (!req.session.user.profileComplete) return res.redirect('/profile');

        if (req.path === '/dashboard' || req.path === '/settings') {
          const filename = req.path === '/dashboard' ? 'dashboard.html' : 'settings.html';
          const filePath = path.join(__dirname, 'views', filename);
          try {
            let html = await fs.promises.readFile(filePath, 'utf8');
            const usersLink = `<a class="${req.path === '/users' ? 'active' : ''}" href="/users">Users</a>`;
            html = html.replace('<a href="/settings">Profile settings</a>', `${usersLink}\n        <a href="/settings">Profile settings</a>`);
            return res.type('html').send(html);
          } catch (error) { return next(error); }
        }

        if (req.path === '/users') {
          return res.sendFile(path.join(__dirname, 'views', 'users.html'));
        }

        if (req.path === '/api/users') {
          if (req.method !== 'GET') return res.sendStatus(405);
          if (!poolInstance) return res.status(503).json({ error: 'Database is not configured' });
          try {
            const result = await poolInstance.query(`
              SELECT u.id, u.first_name, u.last_name, u.email,
                     c.shift_number, c.position, c.schedule_id
              FROM "User" u
              LEFT JOIN "UserScheduleCurrent" current ON current.user_id = u.id
              LEFT JOIN "UserScheduleHistory" c
                ON c.schedule_id = current.schedule_id AND c.user_id = current.user_id
              ORDER BY lower(u.last_name), lower(u.first_name), lower(u.email)
            `);
            return res.json(result.rows.map((row) => ({
              id: row.id,
              name: `${row.first_name} ${row.last_name}`.trim(),
              email: row.email,
              position: row.position,
              shiftNumber: row.shift_number,
              profileComplete: Boolean(row.schedule_id),
            })));
          } catch (error) { return next(error); }
        }

        const detailMatch = /^\/api\/users\/([^/]+)$/.exec(req.path);
        if (!detailMatch || req.method !== 'GET') return next();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(detailMatch[1])) {
          return res.status(400).json({ error: 'Invalid user id' });
        }
        if (!poolInstance) return res.status(503).json({ error: 'Database is not configured' });
        try {
          const userResult = await poolInstance.query(`
            SELECT id, first_name, last_name, email FROM "User" WHERE id = $1
          `, [detailMatch[1]]);
          if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
          const [scheduleResult, openResult, historyResult] = await Promise.all([
            poolInstance.query(`
              SELECT h.schedule_id, h.shift_number, h.position, h.created_at,
                     COALESCE(array_agg(d.day_of_week ORDER BY d.day_of_week)
                       FILTER (WHERE d.day_of_week IS NOT NULL), '{}') AS shift_days
              FROM "UserScheduleHistory" h
              LEFT JOIN "UserScheduleDays" d ON d.schedule_id = h.schedule_id
              WHERE h.user_id = $1
              GROUP BY h.schedule_id
              ORDER BY h.created_at DESC, h.schedule_id DESC
            `, [detailMatch[1]]),
            poolInstance.query(`
              SELECT r.id, r.person_requesting_on AS requester_date,
                     r.request_opened_at AS submitted_at,
                     requester.first_name || ' ' || requester.last_name AS requester_name,
                     NULL::text AS offering_name, NULL::date AS offering_date,
                     'Open' AS status
              FROM "ShiftSwapsOpen" r
              JOIN "User" requester ON requester.id = r.person_requesting
              WHERE r.person_requesting = $1
              ORDER BY r.request_opened_at DESC, r.id DESC
            `, [detailMatch[1]]),
            poolInstance.query(`
              SELECT h.id, h.person_requesting_on AS requester_date,
                     h.person_offering_on AS offering_date, h.submitted_at, h.status,
                     requester.first_name || ' ' || requester.last_name AS requester_name,
                     offering.first_name || ' ' || offering.last_name AS offering_name
              FROM "ShiftSwapsHistory" h
              JOIN "User" requester ON requester.id = h.person_requesting
              JOIN "User" offering ON offering.id = h.person_offering
              WHERE h.person_requesting = $1 OR h.person_offering = $1
              ORDER BY h.submitted_at DESC, h.id DESC
            `, [detailMatch[1]]),
          ]);
          return res.json({ user: userResult.rows[0], schedules: scheduleResult.rows,
            open: openResult.rows, history: historyResult.rows });
        } catch (error) { return next(error); }
      });
    }
    return originalGet(route, ...handlers);
  };
  return app;
};
Object.assign(expressFactory, express);
require.cache[require.resolve('express')].exports = expressFactory;

// Make the server's existing PostgreSQL pool available to the isolated handlers.
const OriginalPool = pg.Pool;
class PagePool extends OriginalPool {
  constructor(...args) {
    super(...args);
    poolInstance = this;
  }
}
pg.Pool = PagePool;
