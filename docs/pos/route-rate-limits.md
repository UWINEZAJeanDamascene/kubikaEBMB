# POS request rate limits

All POS, till, legacy-sales, credit-note, payment-settings, and Print Agent routers use a shared per-IP cap of 3,000 requests per 15 minutes. Public receipt links retain their tighter public limiter. Cashier PIN login, offline PIN-attempt reports, cashier unlock/switch, and Print Agent pairing have additional caps of 20 attempts and 10 attempts per 15 minutes, respectively.

The defaults can be adjusted through `POS_API_RATE_LIMIT_WINDOW_MS`, `POS_API_RATE_LIMIT_MAX`, `POS_AUTH_RATE_LIMIT_WINDOW_MS`, `POS_AUTH_RATE_LIMIT_MAX`, `POS_PAIRING_RATE_LIMIT_WINDOW_MS`, and `POS_PAIRING_RATE_LIMIT_MAX`. Invalid or out-of-range values use the safe defaults.

These counters use the Express in-process memory store. They remain active if Redis is unavailable, but each application process has its own counters and a restart clears them. A multi-instance deployment therefore needs a shared rate-limit store before these caps can be treated as a cluster-wide abuse control. Existing cashier PIN lockout remains an independent account/device control.

`node scripts/check-pos-route-security.js --markdown` records which route declarations inherit these caps. That inventory is static; it does not replace review of controller validation, target-object company ownership, register ownership, or open-shift requirements.
