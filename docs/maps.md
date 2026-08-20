# Maps

ExpoJobCrawler ships two map implementations. Both plot the same markers with the same
meaning — circle for an active vacancy, square for a potential employer, diamond for a
candidate, border colour for the match band — so switching between them changes only where
the tiles come from.

| | OpenStreetMap (default) | Google Maps (optional) |
| --- | --- | --- |
| Library | MapLibre GL | Maps JavaScript API |
| API key | none | supplied by the viewer, per browser tab |
| Cost | none | billed to the key's Google Cloud project |
| Third-party requests | tile server only | Google, from the viewer's browser |
| Markers | real DOM buttons | Maps API symbols |

OpenStreetMap is the default, the fallback whenever the Google map fails, and the only
option unless an operator turns the other one on. Nothing here is required to use the app.

---

## Enabling the Google option

```bash
# .env
NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE=true
```

```bash
docker compose up -d --build web
```

The rebuild is not optional. `NEXT_PUBLIC_*` variables are inlined into the client bundle at
build time, so changing the value without rebuilding changes nothing.

With the flag off, the Google radio button does not render, `GoogleMap.tsx` is never
reached, and the Content-Security-Policy contains no Google hosts. With it on, the policy
gains exactly five allowances (`apps/web/src/lib/csp.ts`):

```text
script-src   https://maps.googleapis.com
img-src      https://*.googleapis.com https://*.gstatic.com
connect-src  https://maps.googleapis.com https://*.googleapis.com
style-src    https://fonts.googleapis.com
font-src     https://fonts.gstatic.com
```

The deployment itself never holds a Google key. There is no environment variable for one,
and no admin field to paste one into.

---

## Creating a key

1. Sign in to the [Google Cloud console](https://console.cloud.google.com/).
2. **Create a project** — or pick an existing one. Anything billed under it is billed to
   whoever owns it, so use a project you control.
3. **Enable billing** on the project. The Maps JavaScript API does not serve tiles without
   it, even inside the free monthly allowance.
4. **APIs & Services → Library → Maps JavaScript API → Enable.** Enable nothing else: this
   app uses no other Maps product.
5. **APIs & Services → Credentials → Create credentials → API key.**
6. **Restrict the key immediately** — see below. An unrestricted Maps key found in a page
   can be used by anyone, on any site, at your expense.
7. **Billing → Budgets & alerts → Create budget.** Set an amount you are willing to lose and
   an email alert at 50/90/100 %. A budget alerts; it does not cap. Combine it with the
   per-API quota in step 8 if a hard ceiling matters more than availability.
8. Optional: **APIs & Services → Maps JavaScript API → Quotas** — lower the daily map-loads
   quota to something matching your actual use.

### Restricting the key

On the key's page in **Credentials**:

- **Application restrictions → Websites.** Add the exact origins the app is served from,
  for example `https://jobs.example.com/*`. Add nothing else — no `*`, no bare domain
  without a scheme. This is what stops a copied key working anywhere but your deployment.
- **API restrictions → Restrict key → Maps JavaScript API.** A key limited to one API is
  worth far less if it does leak.

Referrer restrictions are enforced by Google against the `Referer` header, which a browser
sends but a script does not have to. They raise the cost of abuse considerably; they are not
an authentication mechanism. Treat a Maps key as public-but-fenced, not as a secret.

---

## Using it

On a results page with the flag enabled:

1. Choose **Google Maps** above the map.
2. Paste the key and press **Use key**.

The key is held in `sessionStorage` under `expojobcrawler:maps-key`, and:

- it is **never sent to this server** — not in a request body, not in a cookie, not in a log
  line. The only network request carrying it is the browser's own call to Google;
- it is discarded when the tab closes, since `sessionStorage` is scoped to one tab;
- it is discarded on sign-out;
- it is discarded after **30 minutes without interaction with the map**;
- it is discarded immediately by **Forget key**;
- it is discarded if Google rejects it, with the reason shown rather than a grey map.

The provider choice itself (OpenStreetMap or Google) is remembered in `localStorage`; the key
never is. Choosing Google in a fresh tab therefore shows the key prompt again, which is the
intended cost of not storing it.

Anyone using that browser tab can read the key out of `sessionStorage` — so can a script
running on the page. That is inherent to a Maps JavaScript key, which also travels in the
URL of every request Google receives, and is the reason the referrer restriction in step 6
is not optional.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No Google option above the map | `NEXT_PUBLIC_MAP_PROVIDER_ALLOW_GOOGLE` is not `true`, or the image was not rebuilt after changing it |
| "Google rejected this API key" | The Maps JavaScript API is not enabled, billing is off, or the site does not match the referrer restriction |
| Grey map, console mentions `RefererNotAllowedMapError` | The referrer restriction does not include this exact origin |
| Console reports a CSP violation on `maps.googleapis.com` | The page was served by a build made without the flag; rebuild |
| "That does not look like a Maps API key" | A URL or a quoted value was pasted instead of the key itself |
| Map is blank on the default provider | Unrelated to Google — see the tile server notes in [deployment.md](deployment.md) |

## Changing the OpenStreetMap tile server

The default is `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, whose
[usage policy](https://operations.osmfoundation.org/policies/tiles/) does not permit heavy
or commercial use. Point `NEXT_PUBLIC_MAP_TILE_URL` at your own tile server or a paid
provider for anything beyond light use; the origin is added to the CSP automatically. Keep
the OpenStreetMap attribution visible.
