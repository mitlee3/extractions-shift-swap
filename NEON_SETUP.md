# Connect this backend to Neon

The Express backend uses `pg` to connect to Neon PostgreSQL. It reads the database URL from `DATABASE_URL` and queries the existing `"ShiftSwaps"` and `"User"` tables. No schema migration is required for this read-only dashboard integration.

## Configure the connection

1. In Neon, copy the connection string for your database. Use the pooled connection string for serverless/deployed workloads when available; the connection string should use TLS (`sslmode=require`).
2. Set it as `DATABASE_URL` in the deployment platform's environment variables or secret manager. Keep it secret; do not commit it to Git or expose it in browser-side code.
3. Keep the existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_URL`, and `SESSION_SECRET` environment variables configured as before.
4. Install dependencies and start the app:

```sh
npm install
npm start
```

For local development, set `DATABASE_URL` in your shell or in an ignored `.env` file using an environment-variable loader. Do not paste the real connection string into source code.

## What the integration reads

The authenticated `GET /api/shift-requests` endpoint joins each `"ShiftSwaps"` row to the requesting user and, when present, the offering user in `"User"`. The dashboard displays those names, the two requested dates, and the status. The open, approved, and pending counts are calculated from the returned rows; `Requesting` is counted as pending.

`ShiftSwapsIndividual` is not currently queried. The integration only reads the database; it does not yet create or update swap records.
