# Authentication System — Quick Reference

## Admin Login

- **URL:** `http://YOUR_DOMAIN/admin/login`
- **Username:** `masterops`
- **Password:** `#Admin_ops#`

### Environment Variables (`.env.local`)
```env
ADMIN_USERNAME=masterops
ADMIN_PASSWORD=#Admin_ops#
JWT_SECRET=slate-jwt-secret-9a8b7c6d5e4f3e2d1c0b9a8f7e6d5c4b
```

## Client Login

- **URL:** `http://YOUR_DOMAIN/client/login`
- Clients log in with their **license key** (SLT-XXXX-XXXX-XXXX-XXXX) + **registered email**

### What Clients See
After logging in, clients are directed to `/client/dashboard` showing:
- License key (with reveal button)
- License status + expiry date
- Active package + included plugins
- Payment method + billing cycle
- Live site health status + latency
- Environment details (core/agent versions)

## Route Protection (Middleware)

The guard lives at the project root in `middleware.ts`. An empty `app/middleware.ts`
exists only to document that Next.js ignores middleware placed inside `app/`.

| Route Pattern | Auth Required | Redirects To |
|---|---|---|
| `/admin/*` (except login) | Admin session | `/admin/login` |
| `/licenses`, `/sites`, `/packages`, `/migrations`, `/settings/*`, `/integrations` | Admin session | `/admin/login` |
| `/client/*` (except login) | Client session | `/client/login` |
| `/pricing`, `/`, `/api/*` | None | — (public) |

### Verifying the guard actually works

Run these after any change to the session layer:

```bash
node scripts/verify-token-crypto.js   # HMAC matches node:crypto
node scripts/e2e-login.js             # login reaches the dashboard (needs a running server)
node scripts/diagnose-middleware.js   # per-cookie behaviour of the guard
```

**Do not trust the guard's logs alone.** `lib/auth.ts` now uses a dependency-free
HMAC precisely because the middleware runtime provides neither `node:crypto`'s
Buffer helpers nor `crypto.subtle` in a usable form. If you reintroduce either,
the signature silently fails to verify and every protected page redirects while
the login endpoint keeps returning 200.

## Logout

- **Admin:** Click the 🔴 LogOut button in the header bar
- **Client:** Click "Sign Out" on the client dashboard

## Key Files

| File | Purpose |
|---|---|
| `lib/auth.ts` | Token creation, verification, admin/client authentication |
| `middleware.ts` | Route protection (project root — Next.js ignores `app/middleware.ts`) |
| `/app/api/admin/login/route.ts` | Admin login API |
| `/app/api/client/login/route.ts` | Client login API |
| `/app/api/auth/verify/route.ts` | Session verification |
| `/app/api/auth/logout/route.ts` | Logout (clears cookie) |
| `/app/admin/login/page.tsx` | Admin login UI |
| `/app/client/login/page.tsx` | Client login UI |
| `/app/client/dashboard/page.tsx` | Client license dashboard |
