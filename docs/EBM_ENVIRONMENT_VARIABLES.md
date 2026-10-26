# EBM Environment Variables

## Table of Contents

- [Purpose](#purpose)
- [Environment Variables](#environment-variables)
- [Switching Modes](#switching-modes)
- [Validation Checklist](#validation-checklist)

## Purpose

This document lists every environment variable used by the RRA EBM integration. Set these values in the backend server environment, for example in `.env`, `.env.production`, Docker secrets, or the hosting provider's environment variable panel.

The same application build supports all three modes. Select the mode and the deployed VSDC URL through deployment configuration, then restart the backend; switching modes does not require source-code edits. `sandbox` means RRA Test VSDC. The application always sends requests to the VSDC web service; the deployed VSDC WAR is responsible for connecting to the corresponding RRA Test or Production service. Use isolated deployment configuration and database state for Test and Production; never promote test fiscal records or sequence state into production.

## Environment Variables

| Variable | Description | Accepted values | Default if omitted | Required | Read by |
|---|---|---|---|---|---|
| `EBM_MODE` | Controls whether the integration uses local mock responses, sandbox VSDC, or production VSDC. | `mock`, `sandbox`, `production` | Operationally none. It must be set explicitly. The current code falls back to `mock` for local development if omitted. | Required | `services/ebmService.js` when the EBM service is constructed and on every VSDC call through that service. |
| `VSDC_BASE_URL` | Base URL of the deployed VSDC web service, commonly `http://localhost:8080/vsdc`. | Absolute HTTP(S) URL without credentials, query parameters or fragment. | Local mock default is not used to send requests. | Required when `EBM_MODE` is `sandbox` or `production`; validated at backend startup. Optional in `mock`. | `services/ebmService.js` transport layer when creating the Axios client. |
| `RRA_VSDC_SAVE_SALES_ENDPOINT` | Selects the save-sales path after the authorized RRA/integrator confirms which path is valid for the deployed VSDC contract. | `/transactions/saveSales` or `/trnsSales/saveSales` only. | `/transactions/saveSales` to preserve existing behavior. | Optional. Do not set to the PDF path until it has been confirmed for the target environment. Restart the backend after changing it. | `constants/ebmSalesEndpoint.js`; shared by the EBM service, request sanitizer, operation catalog, and retry compatibility handling. |
| `EBM_SALES_CONTRACT_CONFIRMED` | Allows non-mock save-sales dispatch after the RRA/integrator has confirmed the request contract. | `true` or `false`. | `false`. | Keep false until endpoint, fields, nesting, identifiers, and lifecycle semantics are authoritatively confirmed. Applies to sandbox and production. | `services/ebmService.js` save-sales dispatch guard. |
| `EBM_SALES_SANDBOX_ALLOW_UNCONFIRMED_CONTRACT` | Allows an explicitly authorized sandbox contract investigation while ambiguities remain. | `true` or `false`. | `false`. | Sandbox only; never enables production dispatch. Record integrator authorization and the exact test scope before enabling. | `services/ebmService.js` save-sales dispatch guard. |
| `EBM_VSDC_TIME_ZONE` | IANA timezone used to format sales confirmation, sale, handover, cancellation, and refund event timestamps. | Valid IANA timezone name confirmed for the VSDC integration. | Unset. Mock uses UTC; non-mock sales payload construction fails closed if unset. | Do not set a production timezone by guess; obtain RRA/integrator confirmation. | `services/ebmSalesService.js` sales date formatter. |
| `RRA_VSDC_ITEM_SAVE_SANDBOX_ENABLED` | Explicit operator opt-in to send candidate item registration requests to an isolated RRA Test VSDC using the save-example/select-response mapping and §4.17 item code generator. | `true` only in an isolated sandbox deployment with approved test credentials; otherwise unset/`false`. | Unset/`false`. Mock mode does not require it. | Required for `/items/saveItems` in sandbox. Does not enable production. | `services/ebmService.js` blocks the save endpoint before transport when absent. |
| `RRA_VSDC_ITEM_SAVE_CONTRACT_CONFIRMED` | Operator attestation that written RRA/integrator evidence resolves the save field mapping and accepted lengths, and the implementation matches it. | `true` only after the evidence and implementation review; otherwise unset/`false`. | Unset/`false`. Mock and sandbox do not require it. | Required for `/items/saveItems` in production. | `services/ebmService.js` blocks the save endpoint before transport when absent. |
| `RRA_VSDC_ITEM_CODE_GENERATION_CONFIRMED` | Operator attestation that the implemented unique item-code generator matches the confirmed §4.17 contract and has passed sandbox verification. | `true` only after the exact algorithm is confirmed and verified against RRA evidence; otherwise unset/`false`. | Unset/`false`. Mock and sandbox do not require it. | Required for `/items/saveItems` in production. | `services/ebmService.js` blocks the save endpoint before transport when absent. |
| `RRA_ITEM_SELECT_INITIAL_CURSOR` | Taxpayer-approved starting cursor for `/items/selectItems`. | A real 14-digit `YYYYMMDDHHmmss` timestamp. | Mock only uses its deterministic development baseline. No sandbox/production default. | Required before item sync in sandbox and production. | `services/ebmItemSyncService.js` validates this before device/database access. |
| `RRA_ITEM_SELECT_CURSOR_SEMANTICS_CONFIRMED` | Enables advancing the stored item-select cursor and using it incrementally. Confirmation must cover timezone/clock source, inclusive/exclusive boundary, and equal timestamps. | `true` only after written RRA/integrator confirmation; otherwise unset/`false`. | Unset/`false`; unconfirmed sandbox/production replays the fixed baseline and does not advance it. Mock uses simulated cursor behavior. | Optional; leave disabled until confirmed. | `services/ebmItemSyncService.js` before building the request and committing the cursor. |
| `RRA_SANDBOX_URL` | RRA test server address used for diagnostics and mode configuration display. | A valid HTTPS URL. Current expected value: `https://sdcsandbox.rra.gov.rw`. | `https://sdcsandbox.rra.gov.rw` | Optional, unless RRA changes the sandbox address. | `services/ebmService.js` environment config. |
| `RRA_PRODUCTION_URL` | RRA production server address used for diagnostics and mode configuration display. | A valid HTTPS URL. Current expected value: `https://api-ebm.rra.gov.rw`. | `https://api-ebm.rra.gov.rw` | Optional, unless RRA changes the production address. | `services/ebmService.js` environment config. |
| `EBM_HTTP_TIMEOUT_MS` | HTTP timeout for calls from the backend to the VSDC application. | Integer from 1000 to 120000 milliseconds. | `30000` | Optional; invalid values fail startup. | `services/ebmService.js` when creating the Axios client. |
| `EBM_INIT_ENCRYPTION_KEY` | 32-byte AES-256-GCM key used to encrypt `intrlKey`, `signKey`, and `cmcKey` in stored initialization responses. | 64 hexadecimal characters or base64 encoding of exactly 32 bytes. | None | Required before sandbox or production device initialization; configure as a deployment secret. | `utils/ebmInitResultProtection.js` before dispatch and when storing initialization responses. |
| `EBM_RETRY_INTERVAL_MINUTES` | How often the retry job scheduler checks for due EBM queue records. | Any positive integer. | `5` | Optional | `services/ebmRetryJob.js` scheduler on startup. |
| `EBM_RETRY_BASE_DELAY_SECONDS` | Base delay for exponential backoff. The first retry delay is based on this value. | Any positive integer. | `60` | Optional | `services/ebmRetryJob.js` and `services/ebmQueueService.js` when calculating `nextRetryAt`. |
| `EBM_RETRY_BATCH_SIZE` | Maximum number of queue records processed in one retry scheduler run. | Any positive integer. | `10` | Optional | `services/ebmRetryJob.js` on each scheduler run. |
| `EBM_MAX_RETRIES` | Maximum retry attempts before a queue record is marked `abandoned` and an alert is created. | Any positive integer. | `5` | Optional | `services/ebmRetryJob.js` and `services/ebmQueueService.js` on every retry attempt. |
| `EBM_CODE_SYNC_INTERVAL_HOURS` | How often RRA standard codes are refreshed for initialized devices. | Any positive integer. | `24` | Optional | `services/ebmCodeSyncScheduler.js` on scheduler startup and `services/ebmCodeSyncService.js` when checking due companies. |
| `EBM_CODE_SYNC_INITIAL_CURSOR` | Taxpayer-approved starting `lastReqDt` for standard-code, item-class, branch, TIN, and notice lookups. The app replays this baseline until each sequence's incremental timestamp semantics are confirmed. | A real 14-digit `YYYYMMDDHHmmss` timestamp approved for the taxpayer by RRA. | Mock mode only uses `20000101000000`; sandbox/production have no implicit baseline and refuse sync until configured. | Required in sandbox and production. | `services/ebmCodeSyncService.js` before creating or using a lookup sync cursor. |
| `EBM_STANDARD_CODE_CURSOR_SEMANTICS_CONFIRMED` | Enables incremental standard-code lookup after written confirmation of timezone, boundary inclusivity, and equal-timestamp behavior. | `true` only after confirmation; otherwise unset/`false`. | Unset/`false`; sandbox/production replay `EBM_CODE_SYNC_INITIAL_CURSOR` and do not advance this cursor. Mock simulates incremental sync. | Optional until confirmed. | `services/ebmCodeSyncService.js` selects the request cursor and commit policy. |
| `EBM_NOTICE_ALLOWED_HOSTS` | Comma-separated HTTPS host allowlist for notice detail links. A listed host also permits its subdomains. Unsafe, non-HTTPS, credential-bearing, or unlisted links are omitted; the raw RRA value remains in the source record. | Hostnames, for example `rra.gov.rw,notices.rra.gov.rw`. | `rra.gov.rw` | Optional | `services/ebmCodeSyncService.js` before a notice link is exposed to clients. |
| `EBM_ITEM_CLASS_DELTA_CURSOR_CONFIRMED` | Enables incremental item-class cursors only after RRA confirms timezone, boundary inclusivity, and equal-timestamp semantics for `/itemClass/selectItemsClass`. | `true` only after confirmation; otherwise leave unset or `false`. | Unset/`false`; sandbox/production replay the baseline and do not advance. Mock simulates incremental sync. | Optional until confirmed. | `services/ebmCodeSyncService.js` selects the item-class request cursor and cursor commit policy. |
| `EBM_IMPORT_INITIAL_CURSOR` | Starting `lastReqDt` for imported-item lookup, including full replay while incremental cursor semantics remain unconfirmed. | Required real 14-digit `YYYYMMDDHHmmss` timestamp, approved for this taxpayer by RRA. Invalid/missing values stop sync before device lookup, state creation, or VSDC dispatch. | No default in any mode; explicitly configure mock, sandbox, and production. | Required in all modes. | `services/ebmImportedItemService.js` validates it before creating or using the import sync cursor. |
| `EBM_IMPORT_CURSOR_SEMANTICS_CONFIRMED` | Enables incremental imported-item lookup after written confirmation of timezone, boundary inclusivity, and equal-timestamp behavior. | `true` only after confirmation; otherwise unset/`false`. | Unset/`false`; service replays the configured `EBM_IMPORT_INITIAL_CURSOR` and does not advance. | Optional until confirmed. | `services/ebmImportedItemService.js` selects the request cursor and commit policy. |
| `EBM_PURCHASE_CURSOR_SEMANTICS_CONFIRMED` | Enables incremental purchase-sales retrieval after written confirmation of timezone, boundary inclusivity, and equal-timestamp behavior. | `true` only after confirmation; otherwise unset/`false`. | Unset/`false`; sandbox/production replay `20000101000000` and do not advance. Mock simulates incremental sync. | Optional until confirmed. | `services/ebmPurchaseService.js` selects the request cursor and commit policy. |
| `RRA_VSDC_PURCHASE_SAVE_SANDBOX_ENABLED` | Explicit opt-in for candidate purchase-save DTOs in an isolated RRA Test VSDC deployment with approved test credentials. | `true` only in that isolated deployment; otherwise unset/`false`. | Unset/`false`; mock does not require it. | Required for purchase-save dispatch in sandbox; does not enable production. | `services/ebmService.js` blocks dispatch before transport when absent. |
| `RRA_VSDC_PURCHASE_SAVE_CONTRACT_CONFIRMED` | Attests that written RRA/integrator evidence confirms purchase-save endpoint, field types, code meanings, and serialization. | `true` only after written evidence and implementation review; otherwise unset/`false`. | Unset/`false`. | Required for purchase-save dispatch in production. | `services/ebmService.js` blocks dispatch before transport when absent. |
| `RRA_VSDC_PURCHASE_SAVE_MAPPING_CONFIRMED` | Attests that every transmitted purchase value has an approved source and the mapping has passed sandbox verification. | `true` only after approved source mapping and reviewed sandbox evidence; otherwise unset/`false`. | Unset/`false`. | Required for purchase-save dispatch in production. | `services/ebmService.js` blocks dispatch before transport when absent. |
| `EBM_SALES_CURSOR_SEMANTICS_CONFIRMED` | Enables incremental sales-summary retrieval after written confirmation of timezone, boundary inclusivity, and equal-timestamp behavior. | `true` only after confirmation; otherwise unset/`false`. | Unset/`false`; sandbox/production replay `20000101000000` and do not advance. Mock simulates incremental sync. | Optional until confirmed. | `services/ebmSalesSyncService.js` selects the request cursor and commit policy. |
| `EBM_IMPORT_SYNC_INTERVAL_HOURS` | How often imported items are pulled from RRA customs data. | Any positive integer. | `12` | Optional | `services/ebmImportSyncScheduler.js` on scheduler startup and `services/ebmImportedItemService.js` when checking due companies. |
| `EBM_PURCHASE_SYNC_INTERVAL_HOURS` | How often supplier sales are pulled from RRA for purchase matching and confirmation. | Any positive integer. | `6` | Optional | `services/ebmPurchaseSyncScheduler.js` on scheduler startup and `services/ebmPurchaseService.js` when checking due companies. |
| `EBM_MOCK_FORCE_SAVE_SALES_503` | Test-only switch that forces mock `saveSales` calls to fail with HTTP 503. Use only for retry and abandonment testing. | `true` or unset. | Unset, which means disabled. | Optional and should not be set in sandbox or production. | `services/ebmService.js` mock transport before returning a mock `saveSales` response. |

## Switching Modes

### Switch from mock to sandbox

1. Configure the sandbox deployment with the same application build and an isolated sandbox database. Set mode to sandbox.

   ```env
   EBM_MODE=sandbox
   ```

2. Set `VSDC_BASE_URL` to the deployed **Test VSDC** web service. The backend sends requests to this VSDC service; the VSDC deployment is what targets RRA Test.

   ```env
   VSDC_BASE_URL=http://localhost:8080/vsdc
   ```

3. To test item registration against Test VSDC, explicitly opt in. This sends the provisional field mapping (`itemCd` item identifier, `itemClsCd` classification) and §4.17-generated code to sandbox only. Leave unset when you are not actively testing item registration.

   ```env
   RRA_VSDC_ITEM_SAVE_SANDBOX_ENABLED=true
   ```

4. `RRA_SANDBOX_URL` is display/diagnostic metadata only; it does not control the request transport. The actual transport is `VSDC_BASE_URL`.

   ```env
   RRA_SANDBOX_URL=https://sdcsandbox.rra.gov.rw
   ```

5. Start/restart the sandbox backend so its EBM service loads the configured mode and URL.

6. Open Company Settings, then EBM Devices, and initialize the tenant device in sandbox mode.

7. Trigger a full EBM code sync before creating sandbox transactions.

### Switch from sandbox to production

Keep Test and Production deployments and databases isolated. Promote the same built application artifact; configure Production separately rather than changing the live sandbox process/database in place.

1. Confirm the RRA Production VSDC WAR is deployed to its Production VSDC service and can reach RRA Production.

2. Set Production mode:

   ```env
   EBM_MODE=production
   ```

3. Set `VSDC_BASE_URL` to the Production VSDC service. The VSDC WAR/environment—not an application code branch—selects the RRA Production service.

   ```env
   VSDC_BASE_URL=http://localhost:8080/vsdc
   ```

4. `RRA_PRODUCTION_URL` is display/diagnostic metadata; it does not replace `VSDC_BASE_URL` or route requests directly to RRA.
5. Item registration remains blocked in production until written RRA/integrator confirmation resolves the field meanings/lengths and authorized sandbox evidence verifies the generator and registration flow. Only then set both production attestations; sandbox opt-in does not authorize production.

   ```env
   RRA_PRODUCTION_URL=https://api-ebm.rra.gov.rw
   ```

5. Start the Production backend from the same application build. Startup validates that the configured VSDC URL is valid.

6. Open Company Settings and initialize the Production device. Initialization state is stored per environment; Test initialization never counts as Production initialization.

7. Trigger a full code data sync in Production.

8. Submit only a real authorized transaction in Production; do not create a fabricated test invoice. Confirm returned fiscal status/identifiers are from the Production environment.

## Validation Checklist

- `VSDC_BASE_URL` points to the deployed Test or Production VSDC service for the selected mode.
- `EBM_INIT_ENCRYPTION_KEY` is set as a backend secret in sandbox and production; losing this key makes stored VSDC initialization keys unrecoverable.
- `EBM_MODE` is explicit in every deployed production process; production startup cannot silently fall back to mock.
- Test and Production use independent databases and VSDC deployments. The same application artifact is configured for each environment.
- EBM readiness shows the active mode, mock-only notice, latest successful VSDC contact and a 24-hour connectivity warning when the last successful response is stale. That warning is diagnostic; VSDC remains authoritative for receipt-number availability.
- `EBM_MOCK_FORCE_SAVE_SALES_503` is not set outside a controlled mock retry test.
- Retry values are positive integers.
- Code, import, and purchase sync intervals are positive integers.
- After changing any EBM environment variable, the backend server has been restarted.
