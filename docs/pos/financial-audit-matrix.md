# POS sales, payments, refunds, and credit audit matrix

Scope: write endpoints in `routes/posRoutes.js`, `routes/salesLegacyRoutes.js`, and the POS-origin paths in `routes/creditNoteRoutes.js` that create or change a sale, tender, refund, stored value, or customer credit balance. `/api/pos` is the mount prefix for `posRoutes.js`; `/api/sales-legacy` is the prefix for `salesLegacyRoutes.js`; credit-note routes mount at `/api/credit-notes`.

“Atomic” means the domain event is inserted using the same Prisma transaction client as the committed state change. The audit event is the action's completion event; additional approval, tender, stored-value, or provider events are allowed when those are distinct committed effects. An idempotent replay does not create a second business effect or completion event.

## Successful mutation routes

| Route | Success event(s) | Transaction owner and exact-once rule |
| --- | --- | --- |
| `POST /api/sales-legacy/direct-sale` | `POS_SALE_COMPLETED` | `createDirectSale` inserts the event through the active transaction client after invoice, journal, stock, and tender work. The idempotent replay exits before posting and emits no second completion event. |
| `POST /api/sales-legacy/offline-sync/push` | `POS_SALE_COMPLETED` per posted sale | Offline sync dispatches each sale through the same `createDirectSale` completion boundary and operation idempotency record. A conflict is quarantined and does not silently discard the sale. |
| `POST /api/pos/payments-v2/direct-sale` | `POS_SALE_PAYMENT_PENDING` | `createPendingSale` writes the event in the transaction creating the pending invoice. |
| `POST /api/pos/payments-v2/sales/:saleId/payments` | `PAYMENT_RECORDED` per tender; `GIFT_CARD_REDEEMED` when applicable | `recordCashPayment` writes the tender event and any stored-value event in the same transaction as payment and wallet updates. Final sale completion then goes through `createDirectSale` and emits `POS_SALE_COMPLETED`. |
| `POST /api/pos/payments-v2/sales/:saleId/complete` | `POS_SALE_COMPLETED` | Completion delegates to the shared `createDirectSale` sale-commit transaction; retries do not emit another completion event. |
| `POST /api/pos/payments/sales/:saleId/payments` | Same events as the V2 cash-payment route | `recordPayment` dispatches supported cash-like tenders to the same transactional payment implementation. |
| `POST /api/pos/payments-v2/sales/:saleId/manual-mobile-money` | `PAYMENT_MANUAL_MOBILE_MONEY_RECORDED` | `posManualMobileMoneyService` writes the event with the payment row in its transaction. |
| `POST /api/pos/payments-v2/sales/:saleId/mobile-money` | No success event: the current API-provider path deliberately returns `POS_PAYMENT_API_UNAVAILABLE` without creating a payment. | The failed 409 response follows the denied-outcome path below. This entry is listed so the registered write-shaped endpoint is not mistaken for a working provider integration. |
| `POST /api/pos/payments/:paymentId/manual-confirm` and `POST /api/pos/payments-v2/payments/:paymentId/manual-confirm` | `PAYMENT_MANUAL_MOBILE_MONEY_CONFIRMED`; approval events when required | Both routes call the same manual-confirm service; confirmation and its audit event commit together. Approval use is separately recorded in the same transaction when consumed. |
| `POST /api/pos/payments-v2/manual-mobile-money/:paymentId/reconcile` | `PAYMENT_MANUAL_MOBILE_MONEY_RECONCILED` | Reconciliation state and event are committed together by the manual mobile-money service. |
| `POST /api/pos/payments/:paymentId/resend` | `PAYMENT_MANUAL_MOBILE_MONEY_RESEND_REQUESTED` | The resend attempt and event are created in one transaction. |
| `POST /api/pos/payments/:paymentId/cancel` | `PAYMENT_CANCELLED` | Conditional payment update and event share one transaction. A concurrent loser emits no success event. |
| `POST /api/pos/payments-v2/sales/:saleId/payments/:paymentId/remove` and `POST /api/pos/payments/refunds` | `PAYMENT_REMOVED`; `GIFT_CARD_REFUNDED` when applicable; `APPROVAL_USED` when required | `createRefund` dispatches to `removePayment`. Payment/refund/wallet/cash effects and their events share the transaction. Idempotent replay emits no second success event. |
| `POST /api/pos/payments-v2/sales/:saleId/refund-and-cancel` | `PAYMENT_REFUND_AND_CANCELLED`; `GIFT_CARD_REFUNDED` and/or `PAYMENT_REFUND_MANUAL_DUE` as applicable; `APPROVAL_USED` when required | Refund tasks, cash movements, gift-card restoration, sale cancellation, and their events use the same transaction. Provider refunds that require an external action remain explicit manual-due tasks, not fabricated successes. |
| `POST /api/pos/payments-v2/refunds/:refundId/resolve` | `PAYMENT_REFUND_RESOLVED` | Refund resolution and event share the transaction. |
| `POST /api/pos/payments-v2/provider-webhooks/:provider/:companyId` | `PAYMENT_PROVIDER_SUCCESS` or `PAYMENT_UNMATCHED_SUCCESS` | Provider event service persists the deduplicated provider event, any matched payment transition, and corresponding event in one transaction. Duplicate provider event keys replay without another effect. |
| `POST /api/pos/credit-accounts/:clientId/payments` | `POS_CREDIT_PAYMENT_RECORDED` | Receipt, invoice allocations, AR ledger, drawer movement, and event use the same transaction. Idempotent replay does not post another receipt or event. |
| `POST /api/pos/credit-accounts/payments/:receiptId/refund` | `POS_CREDIT_PAYMENT_REFUNDED`; `APPROVAL_USED` when required | Receipt refund, AR/journal reversal, cash movement, and event share the transaction. |
| `PUT /api/pos/credit-accounts/:clientId` | `POS_CREDIT_ACCOUNT_UPDATED` | Account state update and before/after event share the transaction. |
| `POST /api/pos/credit-accounts/:clientId/adjustments` | `POS_CREDIT_ADJUSTED`; `APPROVAL_USED` when required | Adjustment ledger, account balance, journal, and event share the transaction. |
| `POST /api/pos/credit-accounts/:clientId/write-offs` | `POS_CREDIT_WRITTEN_OFF`; `APPROVAL_USED` when required | Write-off ledger, invoice/account balance, journal, and event share the transaction. |
| `POST /api/pos/cheques/deposits` and `POST /api/pos/cheques/:chequeId/bounce` | `POS_CHEQUE_DEPOSIT_RECORDED` / `POS_CHEQUE_BOUNCED`; `APPROVAL_USED` when required | Cheque state, movement/journal effects, and event are transaction-scoped. |
| `POST /api/pos/payments/gift-cards/issue`, `POST /api/pos/payments/gift-cards` | `GIFT_CARD_ISSUED` or `GIFT_CARD_LOADED`; `APPROVAL_USED` when required | Gift-card account/ledger update and event share the transaction. |
| `POST /api/pos/payments/gift-cards/deliver` | `GIFT_CARD_DELIVERED` | Delivery state and event share the transaction. |
| `POST /api/pos/payments/gift-cards/reissue` | `GIFT_CARD_REPLACED`; `APPROVAL_USED` when required | Replacement and event share the transaction. |
| `POST /api/sales-legacy/stored-value/issue` | `POS_STORED_VALUE_ISSUED` | Gift-card or customer store-credit account, ledger, accounting posting, cash drawer update when applicable, and audit event share the transaction. The event stores the account id and payment reference, never the secret redeemable code. |
| `POST /api/credit-notes` with `posOrigin: true` | `POS_REFUND_DRAFT_CREATED` | Draft and event are created through the active transaction client. This records initiation only; it is not a posted refund. Idempotent replay creates neither a second draft nor event. |
| `POST /api/credit-notes/:id/confirm` for a POS-origin note | `POS_REFUND_COMPLETED`; fiscal outbox event where applicable | Credit note confirmation, journal, stock/AR effects, refund outbox, and event share the transaction. Non-POS credit notes do not emit this POS event. |
| `POST /api/credit-notes/:id/refund` for a POS-origin note | `POS_REFUND_PAYOUT_RECORDED` | Refund payment, drawer movement where applicable, journal/AR changes, and event share the payout transaction. Idempotent replay emits no second success event. |

## Denied and failed outcomes

`posAuditOutcome` wraps writes in `routes/posRoutes.js` and `routes/salesLegacyRoutes.js`; the POS-origin credit-note draft, confirmation, and payout routes attach it after authorization. A rejected response produces one `POS_ACTION_DENIED` (4xx) or `POS_ACTION_FAILED` (5xx) attempt, including route and safe response code. This is intentionally a separate audit transaction after the failed business transaction has rolled back: a database transaction that rolled back cannot retain its failure row. Domain approval/fiscal events may also be recorded when they represent a separate decision.

The middleware currently logs an audit-storage error and still sends the original response. Therefore this is an attempted failure audit, not a fail-closed guarantee if the audit database itself is unavailable. Requests rejected before a POS actor/company can be resolved also cannot be attributed by this middleware.

## Verification and limits

- `test/posRefundDraftAudit.test.js` asserts one draft event with the active transaction client.
- `test/posFinancialAuditMatrix.test.js` compares the documented endpoint list with registered POS payment, refund, credit, cheque, stored-value, sale, and POS-origin credit-note write routes so newly added routes cannot silently fall outside this matrix.
- `test/posE2eCheckout.test.js` asserts one sale-completion event uses the active transaction client and an idempotent replay adds none.
- `test/posPaymentsV2Controller.test.js` asserts transaction-scoped resend and cancellation audit writes.
- `test/posPaymentService.test.js`, `test/posCreditAccountService.test.js`, and `test/posCreditAccountController.test.js` cover payment and customer-credit service behavior; `test/posAuditOutcome.test.js` covers denied/failed outcome logging.
- The full backend suite has not been certified by this matrix. These entries cover POS financial mutations only; ERP-only credit-note approval/apply/delete and retired `/api/pos/sale` compatibility operations are out of scope.
- Any new financial mutation route must be added to this matrix and a focused test must assert its success event uses the transaction that commits the business mutation.
