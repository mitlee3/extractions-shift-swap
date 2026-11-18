// Add the user-history page and its read-only API to the existing Express app.
// This preload keeps the feature isolated from the existing server routes while
// placing its middleware after the app's session middleware and before its routes.
const express = require('express');
const pg = require('pg');
const fs = require('node:fs');
const path = require('node:path');

let poolInstance;

const expressFactory = function (...args) {
  const app = express(...args);
  const originalGet = app.get.bind(app);
  let pageMiddlewareInstalled = false;

  app.get = function (route, ...handlers) {
    if (!pageMiddlewareInstalled && route === '/dashboard') {
      pageMiddlewareInstalled = true;
      app.use(async (req, res, next) => {
        const apiPath = req.path === '/api/users'
          || req.path.startsWith('/api/users/')
          || req.path === '/api/pending-shift-swaps'
          || req.path.startsWith('/api/pending-shift-swaps/');
        const pagePath = ['/users', '/dashboard', '/settings', '/pending-shift-swaps'].includes(req.path);
        if (!apiPath && !pagePath) return next();

        if (!req.session?.user) {
          if (apiPath) return res.status(401).json({ error: 'Please sign in to continue.' });
          return res.redirect('/');
        }
        if (!req.session.user.profileComplete) {
          if (apiPath) return res.status(403).json({ error: 'Complete your profile to continue.' });
          return res.redirect('/profile');
        }

        if (req.path === '/dashboard' || req.path === '/settings') {
          const filename = req.path === '/dashboard' ? 'dashboard.html' : 'settings.html';
          try {
            let html = await fs.promises.readFile(path.join(__dirname, 'views', filename), 'utf8');
            const usersLink = '<a href="/users">Users</a>';
            const pendingLink = '<a href="/pending-shift-swaps">Pending Shift Swaps</a>';
            html = html.replace('<a href="/settings">Profile settings</a>', `${usersLink}\n        ${pendingLink}\n        <a href="/settings">Profile settings</a>`);
            return res.type('html').send(html);
          } catch (error) { return next(error); }
        }

        if (req.path === '/users') {
          try {
            let html = await fs.promises.readFile(path.join(__dirname, 'views', 'users.html'), 'utf8');
            html = html.replace('<a href="/settings">Profile settings</a>', '<a href="/pending-shift-swaps">Pending Shift Swaps</a>\n        <a href="/settings">Profile settings</a>');
            return res.type('html').send(html);
          } catch (error) { return next(error); }
        }

        if (req.path === '/pending-shift-swaps') {
          return res.sendFile(path.join(__dirname, 'views', 'pending-shift-swaps.html'));
        }

        if (req.path === '/api/users') {
          if (req.method !== 'GET') return res.sendStatus(405);
          if (!poolInstance) return res.status(503).json({ error: 'Database is not configured' });
          try {
            const result = await poolInstance.query(`
              SELECT u.id, u.first_name, u.last_name, u.email,
                     h.shift_number, h.position, h.schedule_id
              FROM "User" u
              LEFT JOIN "UserScheduleCurrent" current ON current.user_id = u.id
              LEFT JOIN "UserScheduleHistory" h
                ON h.schedule_id = current.schedule_id AND h.user_id = current.user_id
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

        if (req.path === '/api/pending-shift-swaps') {
          if (req.method !== 'GET') return res.sendStatus(405);
          if (!poolInstance) return res.status(503).json({ error: 'Database is not configured' });
          try {
            const result = await poolInstance.query(`
              SELECT h.id, h.person_requesting_on, h.person_offering_on,
                     h.submitted_at, h.status,
                     requester.first_name || ' ' || requester.last_name AS requester_name,
                     requester.email AS requester_email,
                     offering.first_name || ' ' || offering.last_name AS offering_name,
                     offering.email AS offering_email
              FROM "ShiftSwapsHistory" h
              JOIN "User" requester ON requester.id = h.person_requesting
              JOIN "User" offering ON offering.id = h.person_offering
              WHERE h.status IN ('Pending', 'Submitted Pending')
              ORDER BY h.submitted_at ASC, h.id ASC
            `);
            return res.json(result.rows);
          } catch (error) { return next(error); }
        }

        const moderationMatch = /^\/api\/pending-shift-swaps\/(\d+)\/status$/.exec(req.path);
        if (moderationMatch) {
          if (req.method !== 'POST') return res.sendStatus(405);
          if (!poolInstance) return res.status(503).json({ error: 'Database is not configured' });
          const swapId = Number(moderationMatch[1]);
          const { action } = req.body || {};
          const message = typeof req.body?.deniedMessage === 'string' ? req.body.deniedMessage.trim() : '';
          if (!Number.isSafeInteger(swapId) || swapId < 1) return res.status(400).json({ error: 'Invalid shift swap id.' });
          if (!['approve', 'deny'].includes(action)) return res.status(400).json({ error: 'Choose approve or deny.' });
          if (message.length > 250) return res.status(400).json({ error: 'Denial details must be 250 characters or fewer.' });
          try {
            const result = await poolInstance.query(`
              UPDATE "ShiftSwapsHistory"
              SET status = CASE
                    WHEN $2 = 'approve' THEN 'Approved by Core'
                    WHEN $2 = 'deny' THEN 'Denied By Core'
                  END,
                  status_timestamp = CURRENT_TIMESTAMP,
                  denied_message = CASE
                    WHEN $2 = 'deny' THEN $3
                    ELSE NULL
                  END
              WHERE id = $1 AND status IN ('Pending', 'Submitted Pending')
              RETURNING id, status, status_timestamp, denied_message
            `, [swapId, action, action === 'deny' ? message : null]);
            if (!result.rows[0]) return res.status(409).json({ error: 'This shift swap is no longer pending.' });
            return res.json(result.rows[0]);
          } catch (error) { return next(error); }
        }

        const detailMatch = /^\/api\/users\/([^/]+)$/.exec(req.path);
        if (!detailMatch || req.method !== 'GET') return next();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(detailMatch[1])) {
          return res.status(400).json({ error: 'Invalid user id' });
        }
        if (!poolInstance) return res.status(503).json({ error: 'Database is not configured' });
        try {
          const userResult = await poolInstance.query('SELECT id, first_name, last_name, email FROM "User" WHERE id = $1', [detailMatch[1]]);
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

const OriginalPool = pg.Pool;
class PagePool extends OriginalPool {
  constructor(...args) {
    super(...args);
    poolInstance = this;
  }
}
pg.Pool = PagePool;
