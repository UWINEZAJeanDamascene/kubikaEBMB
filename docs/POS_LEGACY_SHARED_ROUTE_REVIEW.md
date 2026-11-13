# Legacy sales and shared ERP route review

The [route inventory](POS_ROUTE_SECURITY_INVENTORY.md) classifies each declared route by its middleware chain and handler. This review records what the route declarations establish; it does not treat shared router/controller names as proof that data ownership or business rules are enforced.

## Legacy sales route classes

| Route group | Route-level boundary | What the boundary means |
| --- | --- | --- |
| `/offline-sync/push` | Device credential plus active POS session and `pos.till.sell` / `pos.payment.take`; revoked-device requests take a quarantine handler | Device/register matching is checked before normal sync. Revoked pushes are quarantined rather than posted. |
| `/offline-sync/device-state` and `/offline-sync/device-state/wipe-ack` | Device credential only | Device protocol routes; they do not inherit ERP `protect`. Wipe acknowledgement is idempotent. |
| `/offline-sync/pull` | POS session plus sell and payment permissions | No ERP `protect` on this route; it is a cashier/device sync path. |
| `/direct-sale` | ERP `protect`, sale permission, POS session and payment permission on online path; shared idempotency | `requireOnlinePosSession` skips its session check only when an offline capability is present. The controller then verifies offline capability/operation fields. |
| `/payment-flow`, `/discounts/apply`, voucher reserve/release, receipt reprint/share, training/proforma, offline snapshot | ERP `protect` plus POS session and route-specific POS permission | These routes intentionally require both ERP API authentication and a till identity. The permission differs by operation. |
| Catalog and receipt reads (`/products`, serial availability, `/receipt/:invoiceId`) | ERP `protect` plus a POS/catalog/sales read permission; no POS session middleware in the route chain | They are ERP-authenticated reads, not cashier-session reads. Object ownership still depends on their handler queries. |
| Held sales, promotion/voucher/price-list administration, stored-value issuance, offline conflict review | ERP `protect` plus route-specific business permissions; no POS session middleware in the route chain | These are back-office operations under ERP identity. The route inventory marks company/register ownership as controller review. |

## Shared credit-note routes

All `/api/credit-notes` routes use ERP `protect` and the router request limit. Their authorization is partly dynamic:

- `POST /api/credit-notes` checks `body.posOrigin`. POS-origin drafts require a POS session for the same company and `pos.till.sell`, then bind actor attribution to the cashier. Other drafts require `credit_notes:create`.
- `PUT` and `DELETE /:id` use `credit_notes:update` and `credit_notes:delete` respectively.
- `POST /:id/confirm` and `POST /:id/refund` load the note by both note ID and ERP company. A POS-origin note requires the same POS cashier boundary; a back-office note checks the actor's `credit_notes:approve` role permission. POS-origin outcomes use the POS audit middleware.
- `POST /:id/submit-ebm`, legacy `PUT /:id/approve`, and `POST /:id/apply` use the credit-note approval permission.
- Read routes use `authorizeCreditNoteRead`; they are not covered by a generic read permission assumption.

The router inventory test covers the mixed ERP/POS route labels and the dynamic draft authorization middleware. It does not replace controller tests for each note state, actor attribution, or company-scoped query.

## Scanner correction and verification

The scanner previously selected a single authentication label when middleware stacks combined ERP auth and POS session auth. It now reports combinations such as `ERP_SESSION+POS_SESSION` and `POS_SESSION+DEVICE_OR_PROTOCOL`, and includes the final handler in the generated inventory. Tests pin representative legacy routes and the shared credit-note draft gate.

Verified here: 221 declared routes scanned; 0 missing declared authentication/authorization/replay gates; focused route-security suite passes. The inventory still marks 111 routes for handler-level tenant review, 73 shift-sensitive routes for open-shift/ownership review, and all 221 routes for controller/service validation review. Those are explicit residual checks, not proven-safe results.
