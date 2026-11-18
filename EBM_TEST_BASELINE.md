# EBM Test Baseline

## Scope and method

This report records the EBM regression state at the pre-Phase-2 commit and compares it with the Phase-2 tree. It is a baseline diagnosis, not approval that either the tests or the implementation are authoritative where their contracts disagree. No EBM service, serializer, test, or runtime behavior was changed during this diagnosis.

- Baseline commit: `2039db15ae32d5c159178524b8fff9103911f11b` (`main`).
- Baseline worktree: `D:\Stock-management\Stock_tenancy_system_ebm_baseline`.
- Command in both trees: `npm run test:ebm` (18 suites).
- Baseline used a fresh local database, `kebmbaseline_20261117_f2975006`, with the 202 baseline migrations.
- Phase 2 used a separate fresh local database, `kebmphase2_20261117_f2975006`, with 203 migrations including the additive Phase 2 migration.
- These were local development databases only. `kubika_dev` was not used for this comparison.

## Result

Both runs report **5 failed suites, 13 passed suites; 105 failed tests, 503 passed tests (608 total)**. The exact 105 failing suite/test keys and the first error line for every case are identical between baseline and Phase 2: 105/105 keys match, 105/105 first error lines match, with no baseline-only or Phase-2-only failures. The Phase 2 changes therefore introduce no new failure in this EBM regression command.

The five failing suites are:

- `test/ebmBranchService.payload.test.js`: 1 failing cases.
- `test/ebmService.endpoints.test.js`: 9 failing cases.
- `test/ebmStockSequenceStep11.test.js`: 4 failing cases.
- `test/ebmVsdcSpecCompliance.test.js`: 5 failing cases.
- `test/vsdcPayloadSanitizer.test.js`: 86 failing cases.

## Phase 3 regression comparison

The pre-edit and final post-refactor `npm run test:ebm` runs on 2026-11-17 each reported 5 failed suites, 13 passed suites, 105 failed tests and 503 passed tests. Both runs match the recorded baseline exactly: the same 105 test keys and first error lines, with no new, removed or changed failures.

The separate `test/posEbmV2RefundService.test.js` suite also has one pre-existing failure on both the current tree and baseline commit `2039db15ae32d5c159178524b8fff9103911f11b`; the other six tests in that suite pass. Its first error is `TypeError: tx.$queryRaw is not a function` from the POS audit transaction mock. It is not part of `npm run test:ebm`, and neither the test nor POS audit service was changed.

## Classification

The 105 failures fall into these observed groups. Classification describes the failing assertion and the mismatch visible in the error; it does not assume whether the implementation or test should change.

- **79**: Payload validation contract mismatch.
- **4**: Branch-save payload allowlist/normalization mismatch.
- **2**: Missing serializer export / implementation-test API mismatch.
- **2**: Missing EBM response helper export.
- **2**: VSDC response normalization/error-contract mismatch.
- **2**: VSDC endpoint/path contract mismatch.
- **2**: Precondition/error-precedence mismatch before endpoint gate.
- **2**: Stock-select validation/data contract mismatch.
- **2**: Mock-mode versus contract-gate expectation mismatch.
- **2**: VSDC response/endpoint contract mismatch.
- **1**: Diagnostic redaction mismatch.
- **1**: Environment-gate expectation mismatch.
- **1**: Missing stock-select precision helper export.
- **1**: Stock-save request schema mismatch.
- **1**: VSDC endpoint catalog/spec mismatch.
- **1**: Branch payload size-validation mismatch.

- **Schema/Prisma client mismatch:** 0 observed.
- **Development database data/state failure:** 0 observed; both runs used separate fresh databases.
- **Date/time dependency:** 0 observed.
- **Environment/mock gate expectation mismatch:** 3 observed (one production environment-gate assertion and two tests expecting mock-mode branch saves to succeed despite the current contract gate).
- The remaining **102** are EBM implementation/test contract mismatches involving payload validation/normalization/redaction, missing helper exports, endpoint paths, precondition ordering, stock schemas, or response contracts. Individual test ownership remains unresolved and no test or EBM behavior was changed to force a pass.
- An earlier, incorrectly nested temporary worktree caused a relative official-PDF fixture path error. The baseline was rerun from the correct repository depth; that setup-only error is excluded from the final 105-case list.
- The separate Phase 2 PostgreSQL integration test is not part of `test:ebm`; it was syntax-checked but not run here because it is restricted to its own scratch database.

## Exact failing cases and first error lines

The error column is the first non-empty Jest error line following the failed test heading. Rows are from the baseline run; the same rows and lines appeared in the Phase 2 run.

| Suite | Failing test | First error line | Classification |
|---|---|---|---|
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › allowlists the documented flat branch-save request for /branches/saveBranchCustomer | expect(received).toEqual(expected) // deep equality | Branch-save payload allowlist/normalization mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › allowlists the documented flat branch-save request for /branches/saveBranchUser | expect(received).toEqual(expected) // deep equality | Branch-save payload allowlist/normalization mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › allowlists the documented flat branch-save request for /branches/saveBranchInsurance | expect(received).toEqual(expected) // deep equality | Branch-save payload allowlist/normalization mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › preserves optional nulls and omits absent optional branch-save fields | expect(received).not.toHaveProperty(path) | Branch-save payload allowlist/normalization mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field custNo instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field custTin instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field custNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field adrs instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field telNo instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field email instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field faxNo instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field remark instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field regrNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field regrId instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field modrNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchCustomer field modrId instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field userId instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field userNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field pwd instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field adrs instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field cntc instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field authCd instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field remark instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field regrNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field regrId instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field modrNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchUser field modrId instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchInsurance field isrccCd instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchInsurance field isrccNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchInsurance field regrNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchInsurance field regrId instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchInsurance field modrNm instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects overlength /branches/saveBranchInsurance field modrId instead of truncating it | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field tin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field bhfId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field custNo | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field custTin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field custNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field useYn | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field regrNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field regrId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field modrNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchCustomer field modrId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field tin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field bhfId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field userId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field userNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field pwd | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field useYn | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field regrNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field regrId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field modrNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchUser field modrId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field tin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field bhfId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field isrccCd | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field isrccNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field isrcRt | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field useYn | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field regrNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field regrId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field modrNm | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › requires /branches/saveBranchInsurance field modrId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchCustomer.tin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchCustomer.custTin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchCustomer.bhfId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchUser.tin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchUser.bhfId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchInsurance.tin | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchInsurance.bhfId | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchCustomer.useYn | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchUser.useYn | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid required values before request construction for /branches/saveBranchInsurance.useYn | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects non-finite or non-numeric insurance rate NaN | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects non-finite or non-numeric insurance rate Infinity | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects non-finite or non-numeric insurance rate "20" | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects non-finite or non-numeric insurance rate null | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid branch-save field /branches/saveBranchCustomer before transport | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid branch-save field /branches/saveBranchCustomer before transport | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid branch-save field /branches/saveBranchUser before transport | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid branch-save field /branches/saveBranchUser before transport | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid branch-save field /branches/saveBranchInsurance before transport | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › rejects invalid branch-save field /branches/saveBranchInsurance before transport | expect(received).toThrow(expected) | Payload validation contract mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › redacts branch-user credentials from nested diagnostics and echoed strings | expect(received).not.toContain(expected) // indexOf | Diagnostic redaction mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › serializes purchase NUMBER values from exact strings without floating-point conversion | TypeError: serializeVsdcRequest is not a function | Missing serializer export / implementation-test API mismatch |
| `test/vsdcPayloadSanitizer.test.js` | VSDC payload sanitizer › accepts exact NUMBER maximums and preserves 38-digit integer boundaries on the wire | TypeError: serializeVsdcRequest is not a function | Missing serializer export / implementation-test API mismatch |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › preserves purchase-select NUMBER tokens, including 38-digit invoice identifiers | TypeError: preservePurchaseSelectNumberPrecision is not a function | Missing EBM response helper export |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › preserves exact saveSales fiscal counters and identifies invalid HTTP response JSON | TypeError: preserveSaveSalesResponse is not a function | Missing EBM response helper export |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › separates valid saveSales acceptance, business rejection, and ambiguous malformed outcomes | expect(received).toThrow(expected) | VSDC response normalization/error-contract mismatch |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › accepts the purchase sample data:null but quarantines malformed successful responses | expect(received).toThrow(expected) | VSDC response normalization/error-contract mismatch |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › purchase save mapping environment gate › keeps production disabled until contract and source mapping are confirmed | expect(received).not.toThrow() | Environment-gate expectation mismatch |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › uses RRA VSDC v1.0.5 paths for transaction and stock submissions | expect(received).toBe(expected) // Object.is equality | VSDC endpoint/path contract mismatch |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › uses the branch-save paths printed in RRA VSDC v1.0.5 where resolved | expect(received).toBe(expected) // Object.is equality | VSDC endpoint/path contract mismatch |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › blocks imported-item status dispatch in sandbox until the contract is confirmed | expect(received).rejects.toMatchObject(expected) | Precondition/error-precedence mismatch before endpoint gate |
| `test/ebmService.endpoints.test.js` | EBM VSDC endpoint constants › blocks stock-movement dispatch in sandbox while the PDF endpoint conflict is unresolved | expect(received).rejects.toMatchObject(expected) | Precondition/error-precedence mismatch before endpoint gate |
| `test/ebmStockSequenceStep11.test.js` | RRA stock sequence Step 11 contract regressions › validates the complete documented stock select header and nested item fields at their maxima | TypeError: VSDC stock select response at stockList[0] is malformed (itemList[0].taxTyCd): must be one of the RRA tax type codes A, B, C, or D. | Stock-select validation/data contract mismatch |
| `test/ebmStockSequenceStep11.test.js` | RRA stock sequence Step 11 contract regressions › preserves unknown select response evidence while keeping save request DTOs closed | TypeError: VSDC stock select response at stockList[0] is malformed (itemList[0].taxTyCd): must be one of the RRA tax type codes A, B, C, or D. | Stock-select validation/data contract mismatch |
| `test/ebmStockSequenceStep11.test.js` | RRA stock sequence Step 11 contract regressions › preserves high precision NUMBER values in stock select JSON before validation | TypeError: ebmService.preserveStockSelectNumberPrecision is not a function | Missing stock-select precision helper export |
| `test/ebmStockSequenceStep11.test.js` | RRA stock sequence Step 11 contract regressions › enforces exact stock save/master schemas and serializes precision-sensitive numbers exactly | TypeError: VSDC stock save request.regTyCd must be one of A, M. | Stock-save request schema mismatch |
| `test/ebmVsdcSpecCompliance.test.js` | RRA VSDC v1.0.5 spec compliance › defines all 18 official API paths from section 3.2.1 | expect(received).toBe(expected) // Object.is equality | VSDC endpoint catalog/spec mismatch |
| `test/ebmVsdcSpecCompliance.test.js` | RRA VSDC v1.0.5 spec compliance › mock mode succeeds for #5 Save Branch User via saveBranchUser | EBMServiceError: /branches/saveBranchUser is disabled until its RRA contract is confirmed for this environment. Set RRA_VSDC_BRANCH_USER_SAVE_ENABLED=true only after the required review for section 3.3.3.2 (PDF pp. 29-30). | Mock-mode versus contract-gate expectation mismatch |
| `test/ebmVsdcSpecCompliance.test.js` | RRA VSDC v1.0.5 spec compliance › mock mode succeeds for #7 Save Branch Insurance via saveBranchInsurance | EBMServiceError: /branches/saveBranchInsurance is disabled until its RRA contract is confirmed for this environment. Set RRA_VSDC_BRANCH_INSURANCE_SAVE_ENABLED=true only after the required review for section 3.3.3.3 (PDF pp. 30-31). | Mock-mode versus contract-gate expectation mismatch |
| `test/ebmVsdcSpecCompliance.test.js` | RRA VSDC v1.0.5 spec compliance › rejects branch-insurance success with missing data | expect(received).rejects.toMatchObject(expected) | VSDC response/endpoint contract mismatch |
| `test/ebmVsdcSpecCompliance.test.js` | RRA VSDC v1.0.5 spec compliance › rejects branch-insurance success with non-null data | expect(received).rejects.toMatchObject(expected) | VSDC response/endpoint contract mismatch |
| `test/ebmBranchService.payload.test.js` | EBM branch payload builders › does not silently truncate oversized customer identifiers or audit fields | expect(received).toThrow(expected) | Branch payload size-validation mismatch |

## Decision gate

Phase 3 has not started. Review and agree on this exact pre-existing failure baseline before proceeding. Once agreed, any EBM test/implementation remediation should be tracked separately from the platform EBM toggle and should not weaken the existing contract gates or alter enabled-company behavior without an explicit decision.
