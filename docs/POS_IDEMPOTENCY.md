# POS mutation idempotency

## Request contract

All POS HTTP mutations and POS-origin credit-note mutations covered by the shared guard require an `Idempotency-Key` (8–160 URL-safe characters). The unique boundary is company + route scope + key. The server hashes the canonical request parameters/body; reusing a key with different content or a different authenticated actor returns `409`.

The ledger stores no request or response body. It stores a reference to a separate result row; that row contains the bounded HTTP outcome encrypted with AES-256-GCM. Set the same stable `POS_IDEMPOTENCY_ENCRYPTION_KEY` on every API instance (or use the same stable `JWT_SECRET` as the fallback). A retry follows the reference, decrypts the saved status, headers, and response, and returns the original result with `Idempotent-Replay: true`.

For routes using `idempotentHandler`, the handler's Prisma work, encrypted result row, and `COMPLETED` ledger update share one interactive transaction. The response is not sent until commit succeeds. The ambient transaction context makes direct `prisma` model calls and nested transaction helpers join that transaction. A failed response/result write therefore rolls back the business writes too; a lost acknowledgement after commit can replay the saved result. Deterministic 4xx responses are committed as results. 5xx outcomes and transaction failures roll back and can be safely retried; a commit acknowledgement failure is quarantined as `NEEDS_REVIEW`.

The result size is limited to 1 MiB. An oversized result rolls the transaction back and returns a retryable error, so it cannot leave an untracked business success. External effects such as email or third-party API calls are outside PostgreSQL's transaction guarantees and must use their own durable outbox/provider identity.

Requests whose 15-minute reservation lease expires are quarantined as `NEEDS_REVIEW`; the server never reruns an ambiguous outcome automatically. The POS Back Office Approvals page shows these records. A manager must check the underlying sale/payment/shift first and record an audited resolution. `CONFIRMED_NOT_COMPLETED` permits one retry with the original key; `CONFIRMED_COMPLETED` permanently blocks it.

The browser reuses a pending key for an identical request from `sessionStorage`. Only the opaque key and a request fingerprint (SHA-256 when Web Crypto is available) are persisted there; request content, credentials, PINs, and tokens are not. A completed response clears that key. Existing explicit domain keys take precedence.

The PostgreSQL worker sweeps expired request leases in batches every minute and moves them to `NEEDS_REVIEW`. The approval page also applies the same idempotent quarantine when it loads, so requests remain visible if the background worker is stopped.

## Covered HTTP mutations

- `/api/pos/**`: payment/settings/register/session/shift/cash/approval/back-office mutations and idempotency/offline exception resolution. Retired `/sale`, `/sale/:id/pay`, and drawer aliases are guarded too.
- `/api/tills/**`: cashier shift actions and register/device administration.
- `/api/sales-legacy/**`: held sales, promotions, vouchers, price lists, stored value, direct sale, offline conflict/wipe acknowledgement, receipt operations, and training/proforma documents. The one-use offline snapshot endpoint is excluded because its response contains a capability token; its own nonce and expiry rules remain authoritative.
- `/api/credit-notes/**`: draft, confirmation, application, refund, and EBM submission mutations.
- `/api/clients/:id` updates (including credit-account terms) and `/api/customers/:id/loyalty-adjustments`: shared request replay sits in front of the customer/account mutation while the append-only customer ledger keeps its company-scoped business key.

## Checkout transaction boundary

Legacy direct checkout, V2 pending-sale creation, and V2 online/offline completion converge on `salesLegacyController.createDirectSale`. Each checkout request reserves and finalizes its company-scoped `pos_sale_requests` row in the same transaction as its invoice creation or completion effects, including tenders, inventory, and accounting-posting records or retry intent. V2 completion uses its completion key in that table; `invoice.posCompletionKey` remains a second domain-level replay check. The shared HTTP wrapper commits its replay-result reference in the same transaction, so a lost response acknowledgement does not strand a committed sale outside the shared ledger.
- `/api/ebm/pos-settings` and `/api/ebm/queue/v2/**`: V2 EBM settings, retry, reprint, and approval actions. Legacy EBM endpoints are unchanged.

Mutating requests with inherently separate domain semantics retain their existing protections: PIN login/offline attempt reporting counts authentication attempts; print-agent pair/refresh uses one-use pairing credentials and token rotation; provider webhooks use provider event identity; offline-sync push uses operation IDs and device sequence; and print-agent lease/ack/fail transitions use persisted print-job IDs and state transitions. They are not blindly replayed through the HTTP response ledger.

## Background work identity

POS background workers use durable operation identities at the business boundary rather than a new timer-run key:

- Offline sync: device + operation ID/sequence and the stored operation result.
- V2 fiscal submission: the unique company/document/receipt queue row, database lease, `request_sent_at`, and signed/ambiguous state transitions.
- Print delivery: persistent print-job ID, lease, and terminal job state.
- Accounting posting: source type + source ID idempotency key and unique posting record.
- Audit checkpoints: company + checkpoint sequence uniqueness.

These are intentionally retained alongside the shared HTTP layer because wrapping them in a generic timer key would not make their external side effects transactional and could bypass their retry/ambiguity policy. A worker may retry only through its own persisted state machine. No generic job wrapper is allowed to resend an ambiguous VSDC, provider, print, or offline operation.

## Operations and limitations

The ledger is tenant-scoped and cascades with company deletion. It has no automatic row cleanup: deleting keys early would make a late client retry executable again. Size monitoring and an approved retention window are required before adding archival. The shared guard prevents concurrent duplicate execution and safe transport retries for the same logical request; existing financial/offline business ledgers remain the final business-level exactly-once boundary. Database writes through the shared Prisma client join the request transaction. External side effects cannot join it and need their own persisted state machine/outbox. Legacy completed rows that held response bodies are migrated to `NEEDS_REVIEW`; they are not silently discarded or replayed in the new format.

Migration `20261113100000_pos_idempotency_atomic_results` removes ledger response bodies, creates encrypted result references, and was applied to the configured local development database.
