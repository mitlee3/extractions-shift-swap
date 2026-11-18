# Connect this backend to Neon

The Express backend uses `pg` to connect to Neon PostgreSQL. It reads the database URL from `DATABASE_URL` and uses the tables defined in [`database schema.sql`](database%20schema.sql).

## Configure the connection

1. In Neon, copy the connection string for your database. Use the pooled connection string for deployed workloads when available; the connection string should use TLS (`sslmode=require`).
2. Set it as `DATABASE_URL` in the deployment platform's environment variables or secret manager. Keep it secret; do not commit it to Git or expose it in browser-side code.
3. Keep the existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_URL`, and `SESSION_SECRET` environment variables configured as before.
4. Install dependencies and start the app:

```sh
npm install
npm start
```

For local development, set `DATABASE_URL` in your shell or in an ignored `.env` file using an environment-variable loader. Do not paste the real connection string into source code.

## First-time user profiles

After Google sign-in, the app looks up the verified email in `"User"` case-insensitively. A new profile creates a `"User"` row with the user's name and email, a `"UserScheduleHistory"` row with the selected position and shift number, one `"UserScheduleDays"` row for each selected weekday, and a `"UserScheduleCurrent"` row pointing to that active schedule. Position and shift number are schedule-version properties, not columns on `"User"`.

Weekdays in `"UserScheduleDays".day_of_week` use Monday = 0 through Sunday = 6, matching the schema comments and profile form.

## Dashboard data

The dashboard reads open requests from `"ShiftSwapsOpen"` and completed or pending swaps from `"ShiftSwapsHistory"`. Requesting and offering schedule IDs reference the appropriate user's schedule version in `"UserScheduleHistory"`. Offers can be submitted to `"ShiftOffers"` using the request, offering user, their current schedule, and the offered date.
