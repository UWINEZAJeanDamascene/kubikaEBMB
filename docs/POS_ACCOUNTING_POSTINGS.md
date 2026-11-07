# POS accounting posting retries

For POS events whose journal entries have been built, journal creation runs independently from the business action. A journal failure is recorded in `pos_accounting_postings` and retried by the worker; retrying never replays the sale or other business action. If sale journal construction itself fails due to an accounting setup problem, the original sale context is queued for the worker to rebuild. Retries use the original posting date, stop after eight attempts, and never move an entry into a different accounting period.

## Deployment

1. Generate the Prisma client with `npm run db:generate`.
2. Review and apply the POS accounting posting, source-status, and shift/stored-value status migrations using the normal database deployment process.
3. Restart the worker so its retry scheduler is active.

The migration is not applied by the backfill command. Do not run the backfill in apply mode until the migration is deployed.

## Check posting status

An authenticated POS session with `pos.report.x` permission can request:

```text
GET /api/pos/accounting-postings/{sourceType}/{sourceId}
```

The response includes the posting status, journal IDs, retry counts and timestamps, and the last error. The `sourceType` and document ID must match the posting event. Results are scoped to the company on the POS session.

## Back-office monitor and reports

Users with the `pos.admin:reports` permission (or the established admin, manager, and store-manager roles) can use the Reports Hub's POS Accounting section. Its monitor supports date, status, source type, register, and till-type filters; failed events include the last error and links to created journals. A retry is accepted only for a failed posting with no linked journal. The action is tenant-scoped, audited, and queues the existing posting payload for the retry worker; it does not replay the POS business action.

The back-office API endpoints are:

```text
GET  /api/pos/admin/accounting-postings
POST /api/pos/admin/accounting-postings/{postingId}/retry
GET  /api/pos/admin/accounting-reports?report={report}&from={date}&to={date}&registerId={id}&tillType={type}
```

Supported reports are `reconciliation`, `sales-journal`, `payments-by-method`, `gift-card-liability`, `cash-over-short`, and `write-off-losses`. Reconciliation compares POS invoice totals net of POS credit notes with posted revenue and output-VAT journal lines using each register's mapped accounts; this avoids counting COGS when a POS sale and its inventory postings share one journal. Its result explicitly marks zero difference. It also reports current mapped clearing-account and gift-card-liability balances. Clearing and gift-card balances are point-in-time company balances, not restricted to the selected activity dates. Payments by method reuses the existing POS payment records and statuses. Report results are tenant-scoped and capped to 500 detail rows where applicable.

The retry worker updates the source document when its journal eventually posts or reaches the attempt cap. POS cash movements, stored-value ledger events, and shift variance postings retain `not_required`, `pending`, `posted`, `failed`, or `reversed` in their source records. Shift-close and Z-report snapshots are updated when a variance retry resolves, including exhausted failures with no journal ID. Cash-funded gift-card issue/load events count as drawer cash once; non-cash tenders do not. Cash rounding remains disabled until its allocation and account treatment are defined. A deferred sale build retry updates the invoice and its journal-entry references from the rebuilt entries.

## Backfill completed sales

The command defaults to a non-mutating dry run:

```text
node scripts/backfill-pos-accounting-postings.js
```

Optionally limit the scan to a company:

```text
node scripts/backfill-pos-accounting-postings.js --company-id <24-character-company-id>
```

After reviewing the dry-run output and deploying the migration, enqueue eligible completed POS sales for retry with `--apply`:

```text
node scripts/backfill-pos-accounting-postings.js --apply
```

The backfill only considers POS-origin invoices in `fully_paid` or `partially_paid` status that have no revenue journal entry. Existing posting records are skipped. It does not create journals or alter sale data; the worker handles queued postings.

## POS cheque lifecycle

The cheque lifecycle migration creates tenant-scoped cheque and deposit records and backfills eligible historical POS cheque tenders. Review and apply that migration through the normal database deployment process before exposing these endpoints; the implementation does not apply migrations automatically.

An authenticated POS session with `pos.payment.reconcile` permission can:

```text
GET  /api/pos/cheques?status=in_hand
POST /api/pos/cheques/deposits
POST /api/pos/cheques/{chequeId}/bounce
```

Deposits accept a list of cheque IDs, an active company bank account, a bank-slip reference, and an `Idempotency-Key`. A batch posts a debit to the selected bank account and credits each cheque's stored cheque-in-hand account. Bouncing a held cheque credits that same account; bouncing a deposited cheque credits the deposited bank account. Both actions are idempotent, retain audit records, and enqueue journal failures for retry without rolling back the cheque state.

Actions above the company's existing POS cash-out approval limit require a matching one-use `CHEQUE_DEPOSIT` or `CHEQUE_BOUNCE` manager approval. Deposit posting must complete before a deposited cheque can be bounced. Cheque actions do not create or modify bank-reconciliation records, bank charges, or shift cash movements.

Request a one-use token with `POST /api/pos/approvals`, using the matching action and exact context:

- Deposit: `{ bankAccountId, chequeIds, amount, bankSlipReference, depositDate }`; sort `chequeIds` lexically and use an ISO date string, or `null` when omitted.
- Bounce: `{ chequeId, amount, reason }`.

Send the resulting `approvalToken` in the action body or the `X-Pos-Approval-Token` header.

## Stage H qualification: alternate till and full-day accounting

Run this qualification against an isolated local PostgreSQL test database only. Do not use production or a shared database: the PostgreSQL integration tests create and remove fixture rows. Configure `POS_TEST_DATABASE_URL` with a local database whose name ends in `_test`. The integration tests refuse other hosts and database names unless the explicit local-database override is enabled.

### Configure a second till type without code changes

1. Keep the existing register on its current till type. Create a second register and assign a distinct `systemTillType` such as `hospitality`.
2. In POS accounting settings, configure the required account mappings for that till type. Use active, directly-postable accounts with the required account types; use distinct codes for the verification so the source of each balance is unambiguous.
3. Configure the register's normal POS payment methods, discount policy, gift-card support, bank account, and shift permissions. Do not add a till-type branch or special-case to the application.
4. Complete a sale on the second register and inspect its journal. The test `posSaleJournalBuilder.test.js` verifies that the same builder resolves company defaults and `hospitality` overrides from configuration and produces balanced journal lines for cash, card, MTN MoMo, Airtel Money, bank transfer, cheque, credit, gift card, store credit, loyalty wallet, loyalty points, and loyalty credit.

### Run the full-day scenario

Use the alternate till and a dedicated test tenant. Record the test date and opening stock/cash balances before starting.

1. Make a discounted, VAT-bearing sale whose stored invoice total, line totals, discount, and tax reconcile. Split payment across every enabled tender type, including both mobile-money providers and a gift-card redemption. Confirm each tender is present once and its journal uses the configured account.
2. Issue or load a gift card with cash, then redeem it on a sale. Verify the stored-value ledger balance and posted liability balance reconcile; do not count a non-cash tender as drawer cash.
3. Create a credit note with one returned line marked `restock` and another marked `write_off`. Confirm the refund reverses the original revenue and VAT accounts, restocked cost returns to the original inventory account, and written-off cost uses the configured loss account. Repeat the same refund request and confirm no duplicate event or journal is created.
4. Record a cash bank deposit with a unique idempotency key and bank-slip reference. Confirm cash-in-transit is traceable and the deposit does not create an unrelated drawer-cash movement.
5. Close the shift with a deliberate cash shortage. Confirm only cash tenders and cash movements affect expected cash, and that the shortage journal and source status are posted (or explicitly failed if posting fails).
6. Retry duplicate sale, refund, and deposit requests with their original idempotency keys. Re-use the same record identifiers under a second test tenant and confirm the first tenant's records are neither visible nor changed. Run the existing gift-card concurrency test against a low-balance card and verify the balance cannot be overspent.
7. Open the Reports Hub's POS Accounting reconciliation and the accounting trial balance for the test date. The POS reconciliation must explicitly report a zero difference; total trial-balance debits must equal total credits. Also inspect payment-by-method totals, gift-card liability, cash over/short, write-off losses, and the linked source journals.

### Automated verification

Run focused deterministic coverage first, then the full backend suite:

```powershell
npm test -- --runTestsByPath test/posSaleJournalBuilder.test.js test/posAccountingProfileService.test.js test/posAccountingReportsController.test.js test/posAccountingPostingService.test.js test/creditNoteAccounting.test.js test/posShiftAccountingService.test.js test/posCashMovementController.test.js
npm test
```

For PostgreSQL-specific behavior, set `POS_TEST_DATABASE_URL` to the isolated local `_test` database and run:

```powershell
npm run test:pos-sale-completion-integration
npm run test:pos-gift-card-concurrency
```

Validate the schema and generate the client before applying migrations. Review migration status only against the isolated test database; do not run migration deploy against a production or shared database as part of this qualification. The backfill reads `DATABASE_URL`, so point it at the same isolated test database without printing or sharing the connection string:

```powershell
$env:DATABASE_URL = $env:POS_TEST_DATABASE_URL
npm run pos:accounting-backfill
```

Review `examined`, `wouldQueue`, `skipped`, and `failed` before any separately approved apply-mode run.
