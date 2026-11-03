# POS and EBM Operations Runbook

For store supervisors, finance operations, and workspace administrators. Use the application screens described below. Do not edit the database, delete a POS pending checkout from browser storage, or create a replacement sale until the original transaction is reconciled.

## Roles and screens

- **POS cashier:** POS page; can inspect their own active shift, count cash, close it, and optionally hand it over.
- **POS manager:** can review till shifts, help with handover/opening-float exceptions, and approve a controlled manager close for another cashier's shift.
- **EBM operator:** EBM Control Center, including the **Retry** tab. Requires EBM read/update access (normally admin or stock manager).
- **Invoice operator:** invoice detail page, **EBM Submission** tab. Requires invoice update access.

In the application, open **EBM Control Center** from the Purchases section. Its **Retry** tab is the durable EBM queue. The invoice's own EBM tab shows fiscal status and the fiscal receipt when one has been issued.

## POS operations dashboard and alert thresholds

Platform administrators can open **Platform Admin â†’ System Health â†’ POS Operations & Service Objectives**. The snapshot refreshes every 30 seconds and reports fleet-wide POS checkout 5xx rate from the recent bounded route sample, closed till variances, retryable EBM queue age, and EBM submission latency. It is a global operations view; it does not expose customer or invoice payloads.

Default thresholds are:

- POS checkout: critical above 5% HTTP 5xx across at least 20 samples in 15 minutes. Expected validation/permission responses (4xx) do not count as server failures.
- Till variance: warn at the configured manager variance threshold (default RWF 50,000); mark critical when five or more shifts cross it in 24 hours.
- EBM queue lag: warn at 5 minutes and critical at 15 minutes for the oldest pending/retryable failed item.
- EBM latency objective: at least 95% of mature queue records submitted within 5 minutes. The 24-hour denominator includes records older than the target, including still-pending and failed records.

Operators can tune these server environment variables: `POS_TILL_LARGE_VARIANCE_THRESHOLD_RWF`, `POS_CHECKOUT_ALERT_MIN_SAMPLES`, `POS_CHECKOUT_5XX_ALERT_PCT`, `POS_EBM_SLO_TARGET_PCT`, `POS_EBM_SLO_TARGET_SECONDS`, `POS_EBM_LAG_WARNING_SECONDS`, and `POS_EBM_LAG_CRITICAL_SECONDS`. Restart the API after changing them. Dashboard alerts are visible to platform administrators while viewing System Health; route these signals to an external paging system if unattended notification is required.

## Manual mobile-money operations

MTN MoMo and Airtel Money are manual-only. No provider credentials, sandbox provisioning, outbound payment request, status polling, webhook, or callback is used. The former automatic request/status endpoints return `Automatic confirmation is not set up yet.` The provider interface remains available for a future implementation, but API mode is not available.

A POS payment settings manager configures the company’s receiving number or merchant code, enables each provider for the company and register, and chooses **VERIFY** (manager confirmation required before sale completion or shift close) or **INSTANT** (counts as received immediately). Cashiers see the shop receiving details and exact balance due, check the SMS or MoMo app, record the transaction ID, optionally enter the payer phone, and confirm receipt. Amounts must be whole RWF and exactly equal the amount due. Transaction IDs are normalized and unique per company and provider.

Managers use the reconciliation panel to filter payments by day, provider, cashier, and status; review provider totals and cashier/status reports; and mark payments MATCHED, MISSING, or DISPUTED. Reconciliation does not create accounting entries. CSV statement import is not available yet. Successful manual payments post to the provider-specific mobile-money clearing account in the single POS V2 completion journal. Mobile-money refunds are sent from the shop wallet, then recorded on the manager refund task with the refund transaction ID; cash refunds are not created.

## Gift card operations (POS API)

- Check a card with `GET /api/pos/payments/gift-cards/:code/balance`. This requires an authenticated POS session with gift-card redemption permission and returns the balance, currency, expiry, and last four code characters.
- Issue or load a card with `POST /api/pos/payments/gift-cards` and an `Idempotency-Key`. Use `operation: "ISSUE"` with an amount and reason to create a card, or `operation: "LOAD"` with the existing card code, amount, and reason. Issue may include an expiry date; load may not. Both operations accept whole-RWF amounts, require an open shift and enabled cash tender, record cash-in and gift-card liability, and require gift-card management permission.
- An issue response includes the new card code once. An idempotent retry returns the prior result without exposing the code again; securely give the original code to the customer and do not rely on retrying to retrieve it.
- Redeem through `POST /api/pos/payments-v2/sales/:saleId/payments` using a `GIFT_CARD` allocation and the card code. The POS checks expiry, currency, customer assignment, and available balance; the balance change, payment, and ledger record are committed together.
- If an issue response is lost, do not issue a replacement with a new key until the original result is reconciled. Use the same key to check for a replay, then escalate if the code is no longer available.

## Running the PostgreSQL gift-card concurrency test

By default, the integration test only accepts `POS_TEST_DATABASE_URL` pointed at a local PostgreSQL database whose name ends in `_test`. For a normal local database, opt in explicitly with `POS_TEST_ALLOW_LOCAL_DATABASE=true`; it still refuses non-local hosts. The test creates temporary rows in the selected database and deletes them afterward. Do not use a production or shared database.

In PowerShell, for the normal local database configured in `.env`, use:

```powershell
$env:POS_TEST_ALLOW_LOCAL_DATABASE = 'true'
npm run test:pos-gift-card-concurrency
$testExitCode = $LASTEXITCODE
Remove-Item Env:POS_TEST_ALLOW_LOCAL_DATABASE
if ($testExitCode -ne 0) { exit $testExitCode }
```

With that opt-in, the test loads `DATABASE_URL` from the process environment or `.env`, verifies the host is loopback, and does not apply migrations. If required POS tables are missing, stop and review the local migration status rather than running migrations against a shared database. The suite calls the real POS controllers to cover competing redemptions, ten simultaneous small redemptions, same-key retry, a redemption racing a refund, transactional rollback after a forced ledger failure, company isolation, concurrent/replayed sale cancellation, missing/reversed/mismatched completion redemptions, and shift-close blocking. It checks ledger totals against account balances after each scenario. Every scenario uses tagged fixture rows and removes them in `finally`; the rollback scenario also removes its temporary PostgreSQL trigger and function.

The rollback check targets the transaction boundary that exists in Payments V2: gift cards are debited when payment is recorded. A later sale-completion failure therefore must leave the already-recorded payment intact; it cannot roll back a payment committed earlier. The `posE2eCheckout.test.js` suite exercises the completion controller/service with mocked persistence boundaries. The PostgreSQL-backed downstream posting test is separate: it uses the real completion controller, sale controller, journal service, inventory models, and database transaction; it forces a journal insert failure, then retries twice concurrently with the same key and verifies the rollback and single committed journal, stock deduction, and EBM dispatch. The test only mocks EBM/notification boundaries and cleans up tagged rows and its temporary trigger in `finally`. Run it against a local test database with:

```powershell
$env:POS_TEST_ALLOW_LOCAL_DATABASE = 'true'
npm run test:pos-sale-completion-integration
$testExitCode = $LASTEXITCODE
Remove-Item Env:POS_TEST_ALLOW_LOCAL_DATABASE
if ($testExitCode -ne 0) { exit $testExitCode }
```

For the focused mocked controller/service test, run:

```powershell
npm test -- --runInBand --runTestsByPath .\test\posE2eCheckout.test.js
```

## 1. EBM queue item failed

### Triage

1. Open **EBM Control Center → Retry** and filter to the affected status or document type.
2. Open **Error** and record the document type/ID, last error, retryability, attempt history, retry count, and next retry time.
3. Follow the error message. For connectivity/timeouts, check that the EBM device/branch shows ready in **EBM Control Center**. For validation errors, check the invoice/credit note and the branch, customer TIN, product tax/item codes, and required fiscal configuration.
4. Open the source document and confirm that it exists and is the correct transaction. Do not create a new sale to replace a fiscal failure.

### Retry

- **pending, transient error:** if its next retry is still in the future, wait for the scheduled retry and refresh. If it is overdue and readiness is healthy, select **Retry** once and inspect the result.
- **failed, non-retryable error:** fix the source/configuration issue first. For invoice sales, use the invoice detail page's **EBM Submission → Submit fiscal sale** action after verifying RRA did not already accept the document. This submits a payload rebuilt from the current invoice. For other document types, use the relevant source-document resubmission workflow if present; if there is no such workflow, escalate with the queue item ID.
- **abandoned:** this means automatic retry attempts were exhausted. Restore EBM readiness, verify the last error and source document, then use **Retry** once. Manual retry resets the retry count and attempts immediately; repeated retries will not fix a bad payload or unavailable RRA service.
- **bulk retry:** use only for a group with the same resolved transient cause. Bulk retry resets records for the background worker; it does not verify or fix their source data.

Refresh the queue and invoice after the attempt. A successful item should show **submitted** and the invoice should display its RRA receipt details. If the error returns, stop retrying and escalate with the exact RRA error, document ID, branch, and attempt timestamps.

### Do not use “Mark Resolved” as a retry or repair

The queue's **Mark Resolved** action only changes the queue record's status. It does not obtain or attach a fiscal receipt to the invoice. Use it only under an approved reconciliation procedure after RRA acceptance has been independently confirmed and the invoice receipt has been reconciled. If the receipt details are absent, escalate; do not mark the item resolved to clear the alert. **Acknowledge** only acknowledges the alert. **Reset alert** resets the queue item for retry; it is not an acknowledgement-only action.

## 2. Till stuck open / register belongs to another cashier

### If you are the cashier who opened the shift

1. Go to **Direct Sale / POS** on the same register and check the active shift panel.
2. Count the physical cash in the drawer, including the opening float. Enter that count in **Counted cash**; do not copy the expected amount unless that is the actual count.
3. Compare with **Expected cash**. If they differ, enter a short factual explanation in **Variance note** (at least five characters).
4. To hand over, enter the next active cashier's workspace email in **Next cashier email**. Leave it blank if there is no handover.
5. Select **Close Till**. Confirm the shift is shown as closed, then let the next cashier open the same register. When there is a handover, their opening float must match the prior closing count; a mismatch requires a POS manager and an explanation.

Expected cash is the register's recorded cash expectation (opening float plus recorded cash activity). It is not the sale total: card, bank transfer, cheque, and mobile-money receipts do not count as drawer cash.

### If the shift belongs to another cashier

Ask that cashier to sign in, count the drawer, close the shift, and enter your email for handover. If they are unavailable, a cashier or supervisor with POS close access can use the **Manager close & reconcile** control shown under the other cashier's active shift. Enter the physical drawer count, an optional next cashier email, and a factual reason of at least 10 characters. A different manager with `tills:close` permission must enter their workspace credentials (and authenticator code if enabled). The transaction rechecks that the shift is still open, locks it while reading current expected cash, closes it once, records the variance, and appends the requester, approver, reason, and timestamp to the shift activity.

If no separate manager with close permission is available, the shift is already closed, or the displayed cash activity does not match the drawer, do not guess the count or open a second shift. Escalate to the workspace administrator with register name/ID, shift owner, opening time, expected cash, physical count, and sales since opening. Do not alter cashier identity or shift rows directly in the database.

### End-of-shift Z-report

Use **View X-report** during an open shift for a live preview; it does not show close time, counted cash, variance, a Z number, or a FINAL label. After closing, open **Recent shift reconciliations** and select **Reprint Z**. The immutable Z snapshot is labeled **FINAL** and includes business name/TIN, branch and register, shift number, cashiers, timestamps, opening float, gross sales, discounts, tax and net sales, refunds, EBM tax-code/rate buckets, payment totals (cash, MoMo, Airtel, card, credit, gift card, and explicitly unspecified mobile money), cash in/out/safe drops, expected and counted cash, difference, void count/amount, no-sale drawer openings, and per-cashier sales/refund subtotals. Select **Screen layout**, **Thermal · 58 mm**, or **Thermal · 80 mm** before printing.

Mobile-money provider is captured when selected in the POS payment form. Older payments without provider metadata remain listed as **Mobile money (unspecified)** rather than being guessed as MoMo or Airtel. No-sale drawer openings require one-time manager approval and are counted after recording. A cash ledger difference is a review signal: compare the report with recorded cash activity and linked invoice/refund records before signing off. POS cash movements are attributed only through invoice-linked POS shifts (never by guessing from register/time overlap). POS credit-note refunds must be recorded while the cashier has an open till so the refund is attributed to that shift; cash refunds reduce expected drawer cash.

## 3. POS idempotency conflict or checkout pending

POS saves one unresolved checkout per company and cashier in that browser. Its idempotency key protects stock and accounting from duplicate submissions.

### `POS_SALE_STILL_PROCESSING` or “Checkout pending confirmation”

1. Keep the same browser, company, cashier account, and POS tab. Do not edit the cart or start another sale.
2. Check network connectivity, wait briefly, then use **Retry saved sale**. It resends the same saved payload and key; a completed prior request returns the existing invoice instead of making another one.
3. If it remains unresolved for more than ten minutes, search **Invoices** for the cashier, customer, approximate time, and total. Do not assume that a timeout means the sale failed.
4. If the matching invoice exists, note its invoice/reference number and contact support to reconcile the saved checkout. If no matching invoice is visible, still do not create a replacement sale; escalate the request key/check-out time to the workspace administrator/engineering support.

### `POS_IDEMPOTENCY_KEY_CONFLICT`

This means the server has already seen that key with a different cashier or sale payload. Do not keep retrying a modified sale or clear the browser's pending checkout. On the original cashier's POS browser, choose **Review conflict & request manager recovery**. Compare the linked invoice reference, customer, and amount with the saved checkout. Continue only when you have verified the saved checkout does not already have an invoice; enter a factual reason and have a different manager approve with their workspace credentials. The server issues a fresh key for the exact immutable saved payload and records the old/new keys, both payload hashes, invoice, requester, approver, and reason. Then choose **Retry saved sale** once. If the existing key has no linked completed invoice, recovery is blocked and the POS administrator must review it; do not create a replacement sale.

### `POS_IDEMPOTENT_SALE_UNAVAILABLE`

The server says the key completed but cannot load its invoice. Stop checkout on that cashier's device and escalate immediately. Do not make a replacement sale; an administrator must reconcile the request and invoice records.

## 4. Fiscal pending after a POS sale

Fiscal submission is asynchronous: the local invoice and payment can complete while RRA certification is still pending. **Pending is not a failed sale and does not mean the cashier should ring it up again.**

1. Find the invoice through **Invoices** and confirm its payment/stock state and invoice reference.
2. Open the invoice detail page's **EBM Submission** tab. If it is pending only briefly, refresh after a few minutes; the background submission/queue worker runs independently of checkout.
3. If still pending, find the matching document in **EBM Control Center → Retry**. Use the transient/failure steps above. Check for a receipt number, fiscal timestamp/signature, and **submitted** status after recovery.
4. If RRA may already have accepted it, confirm receipt status with the RRA/VSDC record before any manual resubmission. If the queue is marked submitted but the invoice has no fiscal receipt, or RRA accepted it but KUBIKA still has no receipt details, stop and escalate for reconciliation. Do not issue another sale or clear the queue item.

## Escalation handoff

Include:

- Workspace/company, register and cashier, local time with timezone.
- Invoice/document reference and ID, amount/payment method, and whether a matching invoice exists.
- EBM queue ID/status, last error code/message, retry count, next retry time, and attempt history.
- Whether EBM readiness is green and whether RRA shows an accepted fiscal receipt.
- For a till: opening time/float, expected cash, physical count, variance note, and intended next cashier.
- For idempotency: exact error code and the original browser/device; never include passwords, authenticator codes, API tokens, or full payment-card details.

## Resolution checklist

- Till is closed/reconciled or handed to the named next cashier; variance has a factual note.
- POS has one verified invoice for the attempted checkout; no replacement sale was created during uncertainty.
- EBM queue and source document agree on status; submitted invoices have their fiscal receipt details, and unresolved RRA acceptance cases remain escalated rather than hidden.
