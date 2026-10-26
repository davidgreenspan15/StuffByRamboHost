# Gesture Flow Commerce API Contract

Status: local launch-candidate contract, version `v1`; not deployed or production-approved
Public base URL: `https://licenses.stuffbyrambo.com/v1`

The Cloudflare license proxy is the only public ingress. It forwards exact `/v1/*`
paths to the Supabase `commerce-api` function and authenticates itself with a
shared upstream secret. Supabase direct function URLs are not public API URLs.
The Supabase `anon` and `authenticated` roles have no commerce-table read or
write privileges; a provider access token cannot bypass the marked portal API.

All JSON requests use `Content-Type: application/json`. Unknown fields are
rejected on mutation endpoints. Successful and error responses use
`Cache-Control: no-store`. Times are UTC ISO-8601 strings unless a signed claim
specifies Unix seconds.

## Common error envelope

```json
{
  "code": "stable_machine_code",
  "publicMessage": "Safe message for a person.",
  "requestId": "request-correlation-id",
  "retryable": true,
  "revocation": "optional-compact-JWS"
}
```

`retryable` is omitted unless true. `revocation` is returned only for a signed
device request whose current license has become inactive. Clients must not infer
authorization from HTTP status alone; they must handle the stable `code`.

## Storefront endpoints

### `GET /catalog/gesture-flow`

Returns either a published product and the exact active policy set:

```json
{
  "product": {
    "sku": "gesture-flow-v3",
    "product": "gesture-flow",
    "edition": "python-mediapipe",
    "name": "Gesture Flow v3",
    "status": "published",
    "published": true,
    "available": true,
    "purchaseAvailable": true,
    "billingModel": "one_time",
    "entitlementType": "perpetual_major",
    "licensedMajor": 3,
    "deviceLimit": 1,
    "price": { "currency": "usd", "unitAmount": 12345, "formatted": "$123.45 (example only)" },
    "features": ["gesture-control"],
    "compatibility": {}
  },
  "policySet": {
    "version": "gesture-flow-us-2026-07-13-v1",
    "documents": [
      {
        "type": "terms_of_sale",
        "version": "version-id",
        "url": "https://stuffbyrambo.com/legal/terms.html",
        "sha256": "64-lowercase-hex-characters",
        "effectiveAt": "2026-07-13T00:00:00Z"
      }
    ]
  }
}
```

The example amount is a non-price placeholder; callers must render only the
live catalog amount. An
unpublished or invalid catalog returns `product.status = "unavailable"` and
`purchaseAvailable = false`; clients must not display a purchase action.

### `POST /checkout-sessions`

Required header: `Idempotency-Key` (16–200 characters). The browser must retain
the same key while retrying the same checkout request.

```json
{
  "sku": "gesture-flow-v3",
  "policySetVersion": "gesture-flow-us-2026-07-13-v1",
  "acceptances": { "terms": true, "refunds": true, "compatibility": true }
}
```

`201` response:

```json
{
  "checkoutSessionId": "cs_test_or_live_id",
  "checkoutUrl": "https://checkout.stripe.com/...",
  "expiresAt": "2026-07-13T12:31:00.000Z"
}
```

Before returning a URL, the service retrieves the configured Stripe Price and
expanded Product and validates environment, active state, one-time billing,
fixed unit amount, product ID, currency, amount, and—under Managed Payments—the
exact configured Product tax code. A permanent mismatch invalidates the intent;
no checkout URL is returned.

### `GET /checkout-status/{checkoutSessionId}`

Returns `{ "status": "open|complete|expired|payment_failed|..." }`, with
`entitlementStatus` once fulfillment has created an entitlement.

## License portal session

Portal sessions use three Secure, HttpOnly, SameSite=Strict, host-only cookies:
Supabase access and refresh tokens plus a backend-signed portal marker bound to
the verified user and Supabase session. Only the successful email-link exchange
can mint the marker; an otherwise valid password or alternate-provider session
without it fails closed. Access, refresh, and marker values are never returned
in JSON or stored by browser code. Authenticated responses return
`X-CSRF-Token`; every state-changing portal request must echo it in
`X-CSRF-Token` and send an allowed `Origin`.

The normalized v1 commerce account email is immutable. Email corrections or
account transfers are not a public API operation and require a separately
reviewed support migration with identity evidence.

- `POST /portal/magic-link` — `{ "email": "person@example.com" }`; always returns
  generic `202 { "accepted": true }` after abuse controls.
- `POST /portal/session` —
  `{ "tokenHash": "fragment-token-hash", "type": "email" }`; verifies the OTP,
  sets the three bound cookies, and returns `{ "authenticated": true }`.
- `DELETE /portal/session` — CSRF-protected; clears all three cookies even when
  the upstream session is stale.
- `GET /portal/me` — returns the v3 account, orders, entitlements, active devices,
  refund requests, and aggregate capacity:
  `{ "deviceAllowance": { "active": 3, "limit": 4, "remaining": 1 } }`.
- `POST /portal/activations/{userCode}/approve` — requires `Idempotency-Key`:

```json
{
  "policySetVersion": "gesture-flow-us-2026-07-13-v1",
  "acceptances": { "terms": true, "compatibility": true }
}
```

- `POST /portal/devices/{activationId}/deactivate` — requires
  `Idempotency-Key`; exact body `{}`.
- `POST /portal/refund-requests` — requires `Idempotency-Key`:

```json
{
  "sku": "gesture-flow-v3",
  "orderId": "order-uuid-selected-from-portal-me",
  "reason": "compatibility",
  "details": "Optional customer detail",
  "licenseRevocationAcknowledged": true
}
```

`orderId` is required and must identify an eligible order returned by
`GET /portal/me` for the authenticated account. The service never infers a
refund target from purchase recency. A successful response includes the same
`orderId` alongside the refund-request ID and status.

## Native app activation

### `POST /device-activation-challenges`

```json
{
  "bundleId": "stuffbyrambo.GestureControlPython",
  "product": "gesture-flow",
  "edition": "python-mediapipe",
  "majorVersion": 3,
  "installationId": "uuid",
  "deviceName": "Rami’s Mac",
  "devicePublicKey": "43-character-base64url-Ed25519-key",
  "deviceKeyAlgorithm": "Ed25519",
  "appVersion": "3.0.0",
  "platform": { "name": "macOS", "version": "15.0", "architecture": "arm64" },
  "legacyMigration": null
}
```

`legacyMigration`, when provided, is untrusted telemetry and never grants a
trial or purchase. Response:

```json
{
  "challengeId": "uuid",
  "userCode": "XXXX-XXXX",
  "verificationUri": "https://stuffbyrambo.com/license/",
  "verificationUriComplete": "https://stuffbyrambo.com/license/?code=XXXX-XXXX",
  "pollToken": "single-purpose-bearer",
  "expiresIn": 600,
  "interval": 5
}
```

### `POST /device-activation-challenges/{challengeId}/exchange`

Authorization: `Bearer {pollToken}`; exact body `{}`. Poll no faster than the
returned interval. `authorization_pending` includes `Retry-After`. Success:

```json
{
  "activationId": "uuid",
  "permit": "compact-GF-PERMIT-JWS",
  "permitExpiresAt": "2026-07-14T12:00:00.000Z"
}
```

A consumed token is idempotent only while the exact activation it created is
still active. It cannot reactivate a deactivated or rebound device.

### Purchase codes (private test and gated production)

Available only while one purchase-code gate is enabled: the private test gate
(test environment, recipient allowlist) or the production gate (live
environment, `LIVE_PURCHASE_CODES_ENABLED`, plus the database live gate). Both
are off by default. When neither is enabled, both routes return `404
not_found`. The request and response shapes, generic errors and rate limits are
the same in both modes. See [`PRIVATE_ACTIVATION_CODES.md`](./PRIVATE_ACTIVATION_CODES.md).

#### `POST /device-activation-challenges/{challengeId}/purchase-code`

Authorization: `Bearer {pollToken}` from the challenge. Exact body:

```json
{ "code": "GF-XXXX-XXXX-XXXX-XXXX" }
```

The code is normalized server side: uppercase, remove whitespace and `-`,
strip a leading `GF` only when 18 characters remain, map `O` to `0` and `I`/`L`
to `1`, then require exactly 16 characters of
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Success is `200` with the same body as
`/exchange` (`activationId`, `permit`, `permitExpiresAt`). Purchase permits
carry `entitlementType: "purchase"` and `deviceLimit: 1`.

A code activates exactly one Mac, once. If this exact Mac (installation and
device key) is already active on the purchase, the response is that existing
activation with a fresh permit, using a new valid challenge if the original
expired; an unused code is not consumed by that. Server limits are
authoritative: purchase permits normally carry `deviceLimit: 1`, but an
admin-granted entitlement may carry any value from 1 to 20, so clients should
accept 1..20 for `entitlementType: "purchase"`. Trial permits carry 2.

| Condition | HTTP | `code` |
| --- | --- | --- |
| Unknown, malformed, used, rotated/revoked, refunded/suspended, wrong product or environment, not allowlisted, live gate off | 400 | `invalid_purchase_code` (one generic message) |
| Missing or malformed bearer, wrong bearer, challenge already approved or consumed by another path | 401 | `invalid_token` |
| Challenge expired | 400 | `expired_token` |
| Purchase already active on its one Mac (code not consumed) | 403 | `device_limit_reached` |
| Installation already active on this purchase with a different device key (code not consumed) | 409 | `device_key_conflict` |
| Valid code, but this Mac is already active on another paid purchase (code not consumed) | 409 | `already_activated` |
| Gate disabled | 404 | `not_found` |
| Missing trusted proxy IP context | 400 | `request_context_missing` |
| Database, rate-limit store or permit persistence unavailable | 503 | `activation_unavailable`, `rate_limit_unavailable`, `permit_persistence_failed` (retryable) |
| Extra body field / `code` not a string | 400 | `unexpected_field` / `invalid_request` |
| Rate limited (20 per IP, 10 per challenge, per 15 minutes) | 429 | `rate_limited` with `Retry-After` |

The earlier `/device-activation-challenges/{challengeId}/email-code` purchase
OTP route has been removed (`404`).

#### `POST /purchase-activation-codes`

Body `{ "email": "person@example.com" }`; always `202 { "accepted": true }`
after abuse controls (5 per IP, 3 per email, per 15 minutes). For an
allowed email (the test allowlist; in production every buyer, or the optional
canary list), every eligible paid purchase of that email in the deployment's
environment whose code is unused gets a new code in its own email, and each previous code stops working.
Purchases whose code was already used get nothing.

## Device-authenticated endpoints

Requests use:

- `Authorization: GestureFlow-Device {activationId}`
- `X-GF-Timestamp: {10-digit Unix seconds}` (within ±300 seconds)
- `X-GF-Nonce: {16–64 random bytes, unpadded base64url}`
- `X-GF-Signature: {Ed25519 signature, unpadded base64url}`

The signed canonical UTF-8 bytes are:

```text
GF1\n{METHOD}\n{PUBLIC_PATH}\n{TIMESTAMP}\n{NONCE}\n{LOWERCASE_SHA256_OF_EXACT_BODY}
```

The nonce is single-use. JSON byte spelling is part of the signature:

- `POST /devices/refresh` exact canonical body
  `{"permitJti":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"}`.
- `DELETE /devices/current` exact body `{}`.

Refresh returns a new permit. An inactive license returns a signed
`GF-REVOCATION` assertion bound to the presented permit JTI. Stable revocation
reasons are `device_deactivated`, `trial_expired`, `refund_pending`, `refunded`,
`dispute_open`, `chargeback_lost`, `admin_revoked`, and
`entitlement_inactive`.

The cross-client proof fixture is
[`device-proof-golden-vector.json`](./device-proof-golden-vector.json).

### Time and key discovery

- `GET /time?nonce={22–128-character-base64url}` returns
  `{ "assertion": "compact-GF-TIME-JWS" }`.
- `GET /license-keys` returns the public Ed25519 JWKS. Private key material is
  rejected from this configuration and never serialized.

## Webhook ingress (Stripe only)

`POST /stripe/webhook` requires a valid raw-body Stripe signature. The only
actionable event names are:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
refund.created
refund.updated
refund.failed
charge.refunded
charge.dispute.created
charge.dispute.updated
charge.dispute.closed
```

Every other valid signed Stripe event is stored as `ignored` and never causes a
Stripe object retrieval. Actionable rows store only a PII-minimized envelope;
the worker retrieves current Stripe objects. Queue completion is fenced by a
per-claim lease token, and failed, dead-lettered, or processing financial events
are never removed by routine retention.
