# Static security headers preparation (SEC-002)

Status: prepared locally, not applied. No DNS, SSL, zone setting or ruleset has been changed. Applying anything below is a separate, explicitly approved provider action.

## Goal

Add HTTP security headers to the commerce pages only, served by the existing GitHub Pages origin through Cloudflare, without changing the site architecture or affecting the homepage and other apps.

- Hosts: exactly `stuffbyrambo.com` and `www.stuffbyrambo.com`.
- Paths: `/gesture-flow`, `/license`, `/legal`, and everything below each (`/gesture-flow/`, `/gesture-flow/success.html`, ...). Matched case-insensitively. Look-alike paths (`/gesture-flowx`, `/licenses/`, `/legalese`, `/gesture-flow.html`) and all other hosts are excluded.
- Origin stays GitHub Pages. The page HTML (including its meta CSP) is unchanged.

## Artifacts (`edge/storefront-security/`)

| File | Purpose |
|---|---|
| `http_response_headers_transform.ruleset.json` | Body for `PUT /zones/{zone_id}/rulesets/phases/http_response_headers_transform/entrypoint`. One rule, action `rewrite`, six static `set` headers. |
| `validate_headers.py` | Offline, stdlib-only check: ruleset shape, the exact route expression, 18 host/path match cases via a small evaluator for the expression grammar used, header values, and that the header CSP never blocks anything allowed by any commerce page's meta CSP. |
| `probe_headers.sh` | Read-only anonymous `curl` probes of commerce and unrelated URLs on both hosts (`expect-off` before, `expect-on` after). |

Run the offline check from the repository root: `python3 -I edge/storefront-security/validate_headers.py .`

## Headers

| Header | Value | Note |
|---|---|---|
| Content-Security-Policy | `default-src 'self'; connect-src 'self' https://licenses.stuffbyrambo.com; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` | The union of the two existing meta policies plus `frame-ancestors 'none'`, which a meta tag cannot set. Browsers enforce both the header and the meta, so pages whose meta says `script-src 'none'` stay that strict. |
| Strict-Transport-Security | `max-age=86400` | Conservative: one day, no `includeSubDomains`, no `preload`. HSTS applies to the whole host once a browser sees it on any path, so the GitHub Pages "Enforce HTTPS" setting must already be on (it is a prerequisite). Raise the max-age only after a stable period, as a separate decision. |
| X-Frame-Options | `DENY` | Legacy frame protection alongside `frame-ancestors`. |
| X-Content-Type-Options | `nosniff` | |
| Referrer-Policy | `strict-origin-when-cross-origin` | |
| Permissions-Policy | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()` | Checkout is a redirect to Stripe-hosted pages, so `payment=()` on our pages does not affect it. |

Rule expression (the only thing that scopes the headers):

```
(http.host in {"stuffbyrambo.com" "www.stuffbyrambo.com"}) and (lower(http.request.uri.path) in {"/gesture-flow" "/license" "/legal"} or starts_with(lower(http.request.uri.path), "/gesture-flow/") or starts_with(lower(http.request.uri.path), "/license/") or starts_with(lower(http.request.uri.path), "/legal/"))
```

The bare-path forms are included because GitHub Pages answers `/gesture-flow` with a 301 to `/gesture-flow/`. Headers on that redirect are harmless, and the redirect stays same-origin.

## Prerequisite blockers (current state)

Response header transform rules run only on proxied traffic. Today the apex has the four GitHub Pages A records and `www` has a CNAME to GitHub, all DNS-only (unproxied), and there is no `http_response_headers_transform` entrypoint (the API returns 404). Until the hosts are proxied, this ruleset has no effect. Proxying is the real change and needs its own approval.

Before proxying, all of the following must hold:

1. **GitHub Pages**: custom domain verified, the certificate issued for both apex and `www`, and "Enforce HTTPS" enabled. Check that `https://stuffbyrambo.com/` and `https://www.stuffbyrambo.com/` both serve a valid certificate directly from GitHub today.
2. **Cloudflare edge certificate**: Universal SSL status Active, covering `stuffbyrambo.com` and `*.stuffbyrambo.com` (SSL/TLS > Edge Certificates, or `GET /zones/{zone_id}/ssl/certificate_packs`).
3. **SSL mode Full (strict)** (`GET /zones/{zone_id}/settings/ssl` returns `strict`). Never Flexible: GitHub Pages redirects HTTP to HTTPS, so Flexible causes a redirect loop. Full (strict) works because GitHub's certificate is publicly trusted for the custom domain.
4. **Features that inject or rewrite HTML must be off for these hosts**, or the CSP will block them: Email Address Obfuscation, Rocket Loader, automatic Web Analytics (RUM) injection and HTML minification. Bot Fight Mode JavaScript detections can inject scripts on challenge pages; review that too. Turn these off zone-wide, or with a Configuration Rule scoped to the same expression.
5. **URL normalization**: leave Cloudflare's default incoming-URL normalization on, so percent-encoded variants of the paths are matched.
6. **Plan**: transform rules are available on Free, and this uses one rule. No paid plan is needed.

Known risk to accept or monitor: once the hosts are proxied, GitHub Pages' domain check may show the DNS as not pointing to GitHub, and certificate renewal may fail. If either happens, proxying blocks Full (strict). Watch the GitHub Pages settings page after proxying, and roll back DNS (below) if the certificate stops renewing.

## Deployment (each step separately approved; none done)

1. Run the offline validator and `probe_headers.sh expect-off`; save the output as a baseline (apex and `www`, commerce and unrelated paths).
2. Confirm prerequisites 1 to 5. Record the current DNS records (IDs, content, proxied=false) and the SSL mode for rollback.
3. Create the ruleset with the rule disabled first: PUT the artifact with `"enabled": false` (the entrypoint does not exist yet, so a PUT creates it). Check that the API accepts the expression.
4. Proxy `www` first (its CNAME, proxied=true). Probe `www`: the site works, the certificate is valid, there's no redirect loop, and there are no new headers yet.
5. Enable the rule (PUT with `"enabled": true`). Run `probe_headers.sh expect-on www.stuffbyrambo.com`, then load each commerce page in a browser and check the console for CSP violations, including the license portal's calls to `licenses.stuffbyrambo.com`.
6. Proxy the four apex A records. Re-run the full `probe_headers.sh expect-on`; the unrelated paths must not receive the commerce CSP (GitHub error pages already send an origin CSP).
7. Watch GitHub Pages certificate status for a renewal cycle before considering a longer HSTS max-age.

Each PUT replaces the whole entrypoint. If someone else adds rules to this phase later, merge into the existing rules instead of overwriting them.

## Rollback

- **Headers only**: PUT the entrypoint with the rule `"enabled": false`, or with `"rules": []`. Takes effect within seconds. Browsers that already saw HSTS keep enforcing HTTPS for up to 24 hours. That is harmless because GitHub Pages already enforces HTTPS.
- **Proxy**: set the A and CNAME records back to proxied=false (DNS-only). Traffic goes straight to GitHub Pages again, with its own certificate.
- **SSL mode**: restore the recorded value. It only matters while the hosts are proxied.

## Verification probes

- Offline: `python3 -I edge/storefront-security/validate_headers.py .` prints `PASS: ruleset shape, 18 host/path cases, 8 pages' meta CSP covered by header`.
- Live, read-only: `edge/storefront-security/probe_headers.sh expect-off` (before) or `expect-on` (after). It exits non-zero if a commerce URL is missing a header, the CSP lacks `frame-ancestors 'none'`, HSTS includes subdomains or preload, or an unrelated URL gets the commerce CSP.
- Manual: `curl -sI https://stuffbyrambo.com/gesture-flow/` should show the six headers, and `curl -sI https://stuffbyrambo.com/` must not receive the commerce CSP. In a browser, the commerce pages and the license portal should load with no CSP console errors.

## Local verification (2026-10-26)

- `validate_headers.py`: PASS, 18 cases and 8 pages.
- Mutation checks: removing `frame-ancestors`, adding `includeSubDomains`, dropping the licenses `connect-src`, or narrowing `/legal/` each made the validator fail.
- `bash -n probe_headers.sh` passed. The author did not run live probes. Parent subsequently ran an anonymous baseline: commerce paths are unpublished (apex404), and GitHub404 responses have their own generic CSP. The probe now distinguishes that origin CSP from the proposed commerce policy, validates its mode/optionalhost, and rejects unavailable commerce pages in expect-on mode. No Cloudflare settings changed.


### Parent prerequisite readback — 2026-10-26

GitHub Pages custom domain and HTTPS enforcement confirmed. Cloudflare Full(strict), active Universal SSL, Rocket Loader off, all minification off, RUM off. Email obfuscation remains ON; disable it only for reviewed commerce routes before proxying. Baseline `expect-off` passes after distinguishing origin404 CSP; unpublished apex commerce URLs return404. No DNS/rules/setting writes.
