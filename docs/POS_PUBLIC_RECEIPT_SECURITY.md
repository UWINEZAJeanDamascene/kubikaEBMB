# Public receipt security

Public receipt URLs are bearer capabilities. The database stores a SHA-256 digest of a 256-bit random token, with expiry and revocation state. Lookup requires the digest to match, the token to be unrevoked, and expiry to be in the future. Invoice lookup is then scoped by both the token row's company ID and invoice ID.

The public receipt router applies a 30-request-per-15-minute per-IP limiter and privacy headers before the limiter and handlers. Successful responses, not-found responses, provider errors, and 429 responses receive `Cache-Control: no-store, private`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

Invalid, expired, revoked, consent-withdrawn, and unavailable receipts return the same plain-text 404 response. Receipt output masks the customer's tax ID and omits cashier identity, tender references, warehouse internals, and arbitrary extension data. PDF downloads use the same already-filtered receipt document as the JSON endpoint.

Verification: `test/publicReceiptRateLimit.test.js`, `test/posPublicReceiptController.test.js`, and `test/posPublicReceiptService.test.js` cover rate limiting, headers on JSON/PDF/429 responses, generic not-found behavior, tenant-scoped invoice lookup, tax-ID masking, omitted private fields, and token hashing/expiry/revocation.

Operational limit: the current rate limiter uses the default in-memory store. Its counter is per server process and resets on restart; deployments with multiple server instances should configure a shared rate-limit store to enforce the cap across the fleet.
