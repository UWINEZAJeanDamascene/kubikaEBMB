# Provider webhook and offline route security review

## Provider payment webhook

`POST /api/pos/payments-v2/provider-webhooks/:provider/:companyId` intentionally has no ERP user session. It inherits the POS router's per-IP request limiter and audit outcome middleware. The handler now requires a supported provider, a 24-hex company ID, a JSON object of at most 64 KiB, a configured provider secret, and a valid HMAC-SHA256 signature over `<unix-timestamp>.<canonical-json-body>`. The signed timestamp must be within five minutes of server time. It rejects invalid signatures or stale timestamps before persisting an event, preventing event-key poisoning.

The handler requires a nonempty external payment reference, a positive whole-number amount, and provider references no longer than 160 characters. `providerTxId` (or the external reference when absent) is the replay key. The database unique index on `(provider, companyId, eventKey)` is authoritative; sequential and concurrent duplicate deliveries return the saved event as `replayed` without applying payment effects again.

The HMAC canonical-JSON format is Kubika's current webhook stub contract. It is not a claim that MTN or Airtel production webhook signing formats have been integrated or verified. Before production provider activation, align verification with the provider's signed headers/raw-body and timestamp contract. The five-minute freshness window limits captured-request replay; stable event identity and database uniqueness prevent repeated business effects within and beyond that window.

## Offline and device routes

| Endpoint | Auth and permission | Payload/replay/rate boundary |
| --- | --- | --- |
| `POST /api/sales-legacy/offline-sync/push` | Enrolled device token; active device must also match POS session/device and have sell/payment permissions. Revoked devices go to quarantine only. | Shared POS per-IP cap; 1–50 operation batch; signed operation envelopes validate tenant, register, sequence, type, dependencies, and device signature; operation ID/sequence are durable idempotency. |
| `GET /api/sales-legacy/offline-sync/pull` | POS session plus sell/payment permissions. | Shared POS per-IP cap; warehouse/cursor checks in controller/service; read only. |
| `GET /api/sales-legacy/offline-sync/device-state` | Enrolled device token. | Shared POS per-IP cap; optional version/queue/storage telemetry is range-checked before updating; read plus heartbeat. |
| `POST /api/sales-legacy/offline-sync/device-state/wipe-ack` | Enrolled device token. | Shared POS per-IP cap; queue depth and export acknowledgement are checked; shared idempotency wrapper. |
| `POST /api/sales-legacy/offline-snapshot` | ERP auth, sale permission, POS session, payment permission. | Shared POS per-IP cap; snapshot capability is one-use and not put in the generic response ledger. |
| `GET/POST /api/sales-legacy/offline-conflicts...` | ERP auth and manager approval permission. | Shared POS per-IP cap; resolution action/reason/reference is validated and tenant-scoped; mutation is idempotent. |
| `GET/POST /api/pos/admin/offline-exceptions...`, `GET /admin/offline-monitoring` | ERP auth; manager approval or report permission. | Shared POS per-IP cap; bounded filters, tenant-scoped queries, validated resolutions, idempotent mutation. |
| `/api/tills/devices...`, register claim/revoke routes | ERP auth and register-management permission. | Shared POS per-IP cap; status/wipe/claim/revoke mutations use idempotency and controller state checks. |
| `GET /api/pos/registers/:registerId/cashiers`, `POST /api/pos/auth/offline-attempts` | Enrolled device protocol credential. | Shared POS cap; offline PIN attempt report has tighter credential cap and monotonic device attempt sequence. |

Verification: `posProviderWebhookController.test.js` and `posProviderEventService.test.js` cover invalid signatures, payload rejection, stable event identity, HMAC verification, sequential replay, and concurrent unique-key replay. `posOfflineSyncController.test.js`, `posOfflineSyncRoutes.test.js`, `posSyncOperationContract.test.js`, and `posRouteSecurity.test.js` cover operation validation/signatures, route middleware, caps, and replay boundaries.

Rate limiters currently use process-local counters. Multi-instance deployments need shared storage for fleet-wide enforcement. The static route inventory identifies controller/service validation responsibilities; it is not a full proof of all database ownership queries or third-party production webhook compatibility.
