# Google sign-in on Cloud Run

This starter app uses Google OpenID Connect to authenticate users with a verified `@gmail.com` address. It requests only `openid`, `email`, and `profile`; OAuth tokens are not retained after the callback.

## Configure Google OAuth

1. In Google Cloud Console, configure the OAuth consent screen and create an OAuth 2.0 **Web application** client.
2. Add the deployed Cloud Run URL plus `/auth/google/callback` to **Authorized redirect URIs** (for example, `https://YOUR-SERVICE-URL/auth/google/callback`). The URI must exactly match `OAUTH_REDIRECT_URL`.
3. Set these environment variables on the Cloud Run service:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET` (prefer Secret Manager rather than a checked-in file)
   - `OAUTH_REDIRECT_URL`
   - `SESSION_SECRET` (a long random secret; for example, generate one with `openssl rand -base64 32`)
   - `NODE_ENV=production`
4. Deploy the directory as a Node.js Cloud Run service. Cloud Run provides `PORT`; the app listens on it.

For local development, set the same variables, use a redirect URI such as `http://localhost:8080/auth/google/callback`, and add it to the OAuth client’s authorized redirect URIs. Run `npm install` then `npm start`.

The app exposes `/auth/google` to start sign-in, `/auth/google/callback` as the OAuth callback, `/me` for the signed-in user, and `/logout` to clear the session. The session cookie is signed and `HttpOnly`; its payload is not encrypted, so this app stores only basic profile fields in it, never access or ID tokens. Change the Gmail-only check in `server.js` if you intend to allow Google Workspace accounts too.
