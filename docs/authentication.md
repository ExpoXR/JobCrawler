# Authentication

Searching needs no account. Everything else — administration, and privacy for your own
searches — does.

Two roles, and no more:

| Role | Can |
| --- | --- |
| `user` | Sign in, own their searches, trigger an on-demand crawl (10 domains) |
| `admin` | All of the above, plus `/admin`: users, model providers, statistics, queue depths and recent crawls; read any search; crawl 50 domains. Blocking a domain and triggering a re-crawl are `/api/admin/*` calls — the dashboard displays their results but has no form for them yet |

There is no self-registration. Accounts are created by an administrator, and
`AUTH_ALLOW_SIGNUP` does not exist — the decision was to leave signup out entirely rather
than ship a flag that defaults to off.

---

## Bootstrapping the first administrator

`ADMIN_EMAIL` and `ADMIN_PASSWORD` seed one account **while the users table is empty**, on the
first sign-in attempt. Afterwards they do nothing at all: the seeding function counts users
first and returns immediately if there are any, so it can neither resurrect a deleted account
nor overwrite a changed password.

Consequences worth knowing before you deploy:

- If both variables were unset on the first run, no account exists. Set them and try again —
  the table is still empty, so seeding will happen then.
- If `ADMIN_PASSWORD` is shorter than **12 characters**, seeding is refused and a warning is
  logged rather than a weak administrator being created.
- If an account already exists and you have lost its password, changing `ADMIN_PASSWORD` will
  not help. See *Recovering* below.

`ADMIN_USERNAME` authenticates nothing. It is a leftover from the HTTP Basic era, kept only
so that existing `.env` files keep validating.

---

## Managing accounts

`/admin/users` lists every account and offers:

- **Create** — email, an initial password (minimum 12 characters), and a role
- **Change role** between `user` and `admin`
- **Disable / enable** — a disabled account cannot sign in, and its sessions end immediately
- **Delete**

Two guards that cannot be clicked past: you cannot delete your own account, and you cannot
demote or disable the **last active administrator**. Locking everyone out of the dashboard
permanently is not a recoverable state, so it is refused rather than warned about.

### Changing a password

**There is no change-password screen yet.** The API accepts it; the UI does not offer it.
Until that lands, an administrator can set any account's password directly:

```bash
curl -X PATCH https://jobs.example.com/api/admin/users \
  -H 'content-type: application/json' \
  -H 'origin: https://jobs.example.com' \
  -b 'ejc_session=<your session cookie>' \
  -d '{"id":"<user uuid>","password":"a-new-password-at-least-12"}'
```

The `origin` header is required — every state-changing route checks it against the
deployment's own origin. Changing a password ends **every session** for that account,
including the caller's own if they changed their own.

This is the one place the documentation and the product disagree: `README.md` and
`.env.example` both tell you to change the seeded password in the dashboard. Until the screen
exists, the command above is how, and `ADMIN_PASSWORD` cannot honestly be cleared before you
have run it.

---

## Sessions

Sessions are **opaque random tokens, not JWTs**. Revocation has to be immediate — disabling an
account or changing a password must end every session at once — and a self-contained token
cannot do that.

| Property | Value |
| --- | --- |
| Cookie | `ejc_session`, `httpOnly`, `SameSite=Lax`, `Path=/` |
| `Secure` | Set when `PUBLIC_BASE_URL` is `https://`, so local HTTP development still works |
| Token | 32 random bytes, base64url |
| Stored | **SHA-256 of the token only.** The database never holds a usable credential |
| Sliding TTL | `AUTH_SESSION_TTL_HOURS`, default 168 (7 days) |
| Absolute TTL | `AUTH_SESSION_ABSOLUTE_TTL_HOURS`, default 720 (30 days), never extended |

The sliding window is only extended once a session is past **half** its life, so an active
session does not turn every request into a database write. The absolute cap is what stops a
stolen session being kept alive indefinitely by use.

A session ends when: the user signs out; the sliding window lapses; the absolute cap is
reached; the account is disabled, deleted, has its role changed, or has its password changed;
or an administrator deletes it.

Each session row also records a **salted hash** of the client address and the user agent —
enough to notice a session being used from somewhere new, not enough to identify a visitor or
to reverse into an address.

---

## Passwords

- **scrypt** from `node:crypto` — N=2¹⁵, r=8, p=1, 64 MB memory ceiling, 32-byte per-account
  salt, 32-byte derived key. No dependency, consistent with the rest of the project speaking
  primitives directly
- Stored as `scrypt$N$r$p$salt$hash`, so the work factor travels with the hash and can be
  raised later without invalidating existing passwords
- Verified with `timingSafeEqual`
- Minimum length 12; no composition rules, because they push people towards `Password1!`
- A sign-in attempt for an account that does not exist **still performs a full hash
  comparison** against a dummy hash, so response timing cannot be used to enumerate accounts.
  Every failure returns the same message regardless of cause

---

## What guards what

| Layer | Does | Does not |
| --- | --- | --- |
| `apps/web/src/proxy.ts` | Redirects `/admin*` to `/login` when **no session cookie is present** | Verify the cookie. It runs on the edge runtime and cannot reach Postgres — **this is not an authorisation check** |
| `requireAdmin()` in each `/api/admin/*` handler | The real check, on the Node runtime, against the database | |
| `guardAdminPage()` in each admin page | Same check, but redirects instead of throwing — a 500 is the wrong answer to "you are not signed in" | |
| `assertSearchAccess()` | Owner-or-admin on a search's results, progress stream and export | |

A search that does not exist and a search belonging to somebody else fail **identically** —
same status, same message. Distinguishing them would turn the endpoint into an oracle for
which search ids exist.

Rate limits: sign-in is 5 attempts per minute per address, `/api/admin/*` 60 per minute,
on-demand crawling 2 per minute. Limits are Redis-backed and shared across web instances,
falling back to per-process in-memory counting when Redis is unreachable.

---

## Search ownership

| Search made | Readable by |
| --- | --- |
| Signed out | Anyone holding the search id — this is how the anonymous product works |
| Signed in | That account and administrators, nobody else |

This closed a real hole: `/api/export` previously treated the search id as the only
credential, so anyone with the URL could download another account's results.

---

## Recovering a lost administrator password

There is no email reset flow — a self-hosted tool with no mail configuration cannot have one.
With database access:

```bash
docker compose exec -T postgres psql -U expojobcrawler -d expojobcrawler
```

```sql
-- Option 1: promote an account you can still sign in as.
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';

-- Option 2: start over. Deleting every user re-arms the bootstrap, so the next
-- sign-in attempt seeds ADMIN_EMAIL / ADMIN_PASSWORD again.
DELETE FROM users;
```

Option 2 also deletes every session, and sets `user_id` to `NULL` on the searches those
accounts owned — which makes those searches anonymous, and therefore readable by anyone
holding their id. Prefer option 1.

Passwords cannot be recovered from the database; scrypt hashes are not reversible. Only
setting a new one works.
