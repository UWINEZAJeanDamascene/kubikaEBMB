# POS EBM / VSDC decisions and source verification

Last reviewed: 2026-11-01  
Decision owner: Business owner  
Policy status: **Operational choices remain PROVISIONAL unless explicitly marked CONFIRMED below.** This review verified published RRA documents; it did not obtain a response from an RRA representative.

## Official source copies

| Source | Official RRA URL | Local copy | SHA-256 |
| --- | --- | --- | --- |
| VSDC API Specification v1.0.5, dated 2023-05-16 | [RRA VSDC v1.0.5 PDF](https://www.rra.gov.rw/fileadmin/user_upload/2023-05-16_VSDC_SPECIFICATION_DOCUMENT_v1.0.5.pdf) | `2023-05-16_VSDC_SPECIFICATION_DOCUMENT_v1.0.5.pdf` | `25df854736b60e7e4eb128bf99904813c5d96acf99464b7b48f23c7fab3df9c1` |
| CIS for VSDC Technical Specification v1.0, released 2018-03 | [RRA CIS specification PDF](https://www.rra.gov.rw/fileadmin/user_upload/20180328_tspe_cis_v4.pdf) (currently redirects to the RRA-hosted `CIS_for_VSDC_technical_Specifications_New.pdf`) | `20180328_tspe_cis_v4.pdf` | `4771b1515d80b48abbc95d5398043fdb2b977351645069f10ea05b8dcfbe3f86` |

The CIS PDF is saved under the requested historical filename. Its title page identifies it as the Technical Specification of CIS for VSDC, version 1.0. These copies were fetched from the official RRA domain on 2026-11-01. The redirect target is also on `rra.gov.rw`.

## Verified statements from the published specifications

These are source facts, not confirmation of all application policies:

1. VSDC v1.0.5 §3.3.6.1 (`/trnsSales/saveSales`) specifies `salesTyCd` as `N` for that endpoint. §§4.8–4.9 define sales type codes `N` Normal, `C` Copy, `T` Training, `P` Proforma; and receipt type codes `S` Sale, `R` Refund after Sale. CIS §13 uses the printed designation `NS` for a normal sale; CIS §§15–17 define copy, training, and proforma designations `CS`/`CR`, `TS`/`TR`, and `PS`. These are distinct API fields and CIS document labels and must not be conflated.
2. Therefore, **CONFIRMED as a code pair only**: a refund submitted through `/saveSales` uses `salesTyCd = N` and `rcptTyCd = R` (VSDC v1.0.5 §§3.3.6.1, 4.8–4.9). The complete refund payload, linkage, limits, approvals, and lifecycle remain subject to the rest of the RRA specification and company policy; this code-pair confirmation does not confirm those behaviors.
3. VSDC v1.0.5 §4.10 documents payment codes `01` Cash, `02` Credit, `03` Cash/Credit, `04` Bank Check, `05` Debit/Credit Card, `06` Mobile Money, `07` Other. The document does not establish that generic bank transfer is Bank Check, or that gift card, store credit, loyalty points, or any other internal method is approved as `07`.
4. CIS §§10–11 say a CIS must not print a receipt of any type before VSDC data flow is finalized and require copy/training/proforma documents to be visibly distinguished, including a designation and a prominent “THIS IS NOT AN OFFICIAL RECEIPT” notice. CIS §§15–17 give the labels and describe the content of those document types. CIS §§18–19 require X/Z reporting of their counts and amounts. These requirements expose compliance conditions; they do not establish that v1.0.5 `/saveSales` accepts these non-normal document types.
5. The v1.0.5 `/saveSales` request schema has no journal submission field. The CIS document discusses journal/report data and, in §24.8, an older CIS-to-authority data flow with a 15-minute transmission limit and commands including `SEND_RECEIPT` and `SEND_RECEIPTITEM`. The reviewed documents do not establish whether this older flow creates an additional journal submission requirement alongside v1.0.5 API calls.
6. VSDC v1.0.5 §4.14 lists error/result descriptions, including 891 (request URL creation), 892 (request header creation), 893 (request body creation), and 894 (server communication occurred). It does not say these codes guarantee that no transaction was recorded. The reviewed specification contains no documented duplicate-invoice result code or safe duplicate retry procedure. A result description alone is not sufficient evidence to retry safely.
7. CIS §24.8’s 15-minute transmission limit is documented for the CIS data-flow mechanism described there. It is not stated as a v1.0.5 `/saveSales` queue deadline. Its applicability to the POS API retry queue remains unconfirmed.

## Company-level policy defaults

The following are business-approved implementation defaults, **not RRA-confirmed rules**. They must remain configurable by company where applicable and visibly identified as provisional in the relevant settings and Z-report views.

| Decision | Provisional behavior | Status / basis |
| --- | --- | --- |
| Internal sale finalization | Finalize journal, stock and payments when payment completes. Keep the sale internally complete if fiscal submission later fails. | PROVISIONAL — business owner instruction, 2026-11-01 |
| Receipt after payment | Wait up to 10 seconds for the signature. If absent, mark `FISCAL_PENDING`; do not hand out a fiscal-looking payment slip; route it to manager resolution. | PROVISIONAL — business owner instruction; timeout is proposed, not specified by RRA |
| VSDC unavailable before payment | Stop new V2 fiscal checkout and preserve the cart. Queue mode defaults OFF and cannot be enabled without a submission deadline. | PROVISIONAL — business owner instruction; applicable deadline open |
| VSDC failure after payment | Preserve completed sale. Retry only on proven pre-delivery transport failure; ambiguous outcomes go to manager review. | PROVISIONAL — retry safety criteria need RRA confirmation |
| Retry and recovery | Never automatically resend an ambiguous request. Manager-confirmed “not received” permits one authorized resend on the same queue row. | PROVISIONAL — business owner instruction; no safe-retry code is confirmed by v1.0.5 |
| Receipt copies | Local reprint of stored signed fields, visibly marked COPY, with audit trail; no VSDC submission by default. Never make a copy of an unsigned receipt. | PROVISIONAL — CIS defines copy document requirements, but permitted VSDC issuance path is open |
| Copy submission setting | `copyReceiptSubmitToVsdc` defaults OFF. | PROVISIONAL — business owner instruction |
| Refund before original signature | Block with “The original receipt has not been confirmed yet.” Route held or permanently failed originals to a manager. | PROVISIONAL — business owner instruction |
| Fiscal refund | Use the confirmed code pair `salesTyCd=N`, `rcptTyCd=R`; link to original signed sale. Enforce cumulative gross and tax limits, idempotency, accounting/stock/payment linkage and approvals. | Code pair CONFIRMED by VSDC v1.0.5 §§3.3.6.1, 4.8–4.9; workflow PROVISIONAL |
| Manual signed-receipt entry | Require a second distinct approver, mandatory evidence note and audit record. Flag the entry in Z and Tax receipts views. | PROVISIONAL — business owner instruction |
| Tender mapping | Use company settings keyed by POS payment enum. Initial documented correspondences: `CASH→01`, `CREDIT→02`, `CARD→05`, `MTN_MOMO→06`, `AIRTEL_MONEY→06`. `BANK_TRANSFER`, `GIFT_CARD`, `STORE_CREDIT`, `LOYALTY_POINTS`, and unknown keys block V2 fiscal submission unless an approved mapping is configured. Never silently fall back to `07`. | Codes documented by VSDC v1.0.5 §4.10; POS correspondences and unmapped-method policy PROVISIONAL |
| Split tenders | Preserve complete local tender breakdown and block splits containing unmapped methods. Code `03` is documented as Cash/Credit only; do not treat it as a generic mixed-tender code. Any other fallback (including largest tender) remains disabled pending confirmation. | PROVISIONAL — business owner instruction; generic mixed tender unresolved |
| Fractional francs | No rounding adjustment; fiscal total equals payable total. Refuse V2 completion if payable total has a fractional franc. Policy hook defaults to `NONE`. | PROVISIONAL — business owner instruction |
| Weighed items and percentage discounts | Do not enable in V2 production until applicable RRA rules are confirmed. | PROVISIONAL — business owner instruction |
| Shift close with unsent documents | Cash count is allowed. Default `shiftCloseFiscalPolicy=REQUIRE_APPROVAL`; waiting, retryable-failed and reconciliation-held documents need manager approval and appear on Z and Tax receipts review. | PROVISIONAL — business owner instruction |
| Training and proforma | Current intended behavior is local-only, with no VSDC call; do not represent it as RRA-approved or compliant until issuance and CIS printing/report requirements are resolved. | PROVISIONAL — business owner instruction; CIS §§10–11 and v1.0.5 §3.3.6.1 leave a material integration question |
| Environment identity | Existing service prevents an invoice already marked submitted from being submitted again in another environment. No environment override is approved. | PROVISIONAL — repository behavior inspected 2026-11-01 |
| Queue and receipt retention | No queue deletion/archive worker was found in the reviewed code. Normal company removal is soft deactivation; hard deletion and backup restore are governed by the existing foreign-key and restore guards. Retention duration remains unset. | PROVISIONAL — repository and database behavior inspected 2026-11-01 |

## Open questions for RRA

Published sources did not resolve these operational questions. Obtain written RRA guidance before changing the corresponding defaults to CONFIRMED:

The offline-fiscal safe default is to block offline sales requiring EBM on both the client and server. The settings UI shows a disabled provisional-receipt option, but it cannot be enabled until RRA/accountant guidance confirms the document's status and permitted use. This is a PROVISIONAL business policy dated 2026-11-11, not an RRA-confirmed rule. VSDC submission and receipt numbering are unchanged.

1. Which exact VSDC v1.0.5 response codes guarantee that no transaction was recorded? In particular, do 891–893 guarantee non-delivery, and what does 894 mean for transaction outcome?
2. What is the officially supported VSDC issuance flow for copy, training and proforma documents when `/saveSales` specifies `salesTyCd=N`? How should CIS §§10–11 requirements be met for them?
3. Does an implementation using VSDC v1.0.5 also have to submit an electronic journal separately, as described in CIS? If so, which API/format and when?
4. Does CIS §24.8’s 15-minute deadline apply to v1.0.5 `/saveSales` submissions after offline operation? What is the applicable deadline and may queued submission be enabled?
5. Is payment code `03` permitted only for a Cash/Credit combination? What should other split-tender combinations use? Is a largest-tender selection permitted?
6. Are Bank Transfer, Gift Card, Store Credit, or Loyalty Points permitted tender types, and what exact codes or reporting treatment apply? Is `07 Other` approved for any of these?
7. What retention period and archive/deletion controls apply to submission records, signed fiscal fields, copies, and audit evidence?
8. Is the proposed 10-second signature wait acceptable? What is the complete required refund payload and process beyond the confirmed `N/R` code pair?
9. Which CIS receipt layout elements (including copy/training/proforma labels, watermark and warning placement/size) must be implemented in each supported print format?
10. What fiscal tender code and receipt reporting treatment does RRA require when a customer redeems POS loyalty points? Until confirmed, loyalty points remain a separate local tender and are disabled in V2 fiscal checkout; no tax or EBM mapping is inferred from the monetary loyalty wallet.
11. What accounting and reconciliation treatment is required for unused offline receipt-number reservations at synchronization and shift close? The current POS control marks a number used in the sale transaction, retires unused numbers at shift close, and reports expired/retired reservations. It does not alter EBM/VSDC numbering.

## POS loyalty points and wallet separation

Effective 2026-11-02, customer loyalty points and the FRw POS loyalty wallet are separate balances with separate append-only ledgers. Existing wallet balances are not migrated or converted. The company setting `pointValueRwf` defaults to RWF 1 per point and controls conversion when points are redeemed in the legacy till. The wallet's existing earning and redemption behavior remains separate. No automatic points-per-sale earning formula was specified; points continue to be granted through the authorized points ledger operation until the company configures a future earning policy. Points redemption is blocked in Payments V2 until its fiscal treatment is confirmed by RRA. This decision is PROVISIONAL for fiscal treatment; accounting and user-interface behavior follow the business owner instruction.

## Confirmation log

| Date | Status | Decision / fact | RRA source or contact | Confirmed by |
| --- | --- | --- | --- | --- |
| 2026-11-01 | CONFIRMED (code pair only) | `/saveSales` refund code pair is `salesTyCd=N`, `rcptTyCd=R`. | RRA VSDC v1.0.5 §§3.3.6.1, 4.8–4.9; official PDF linked above | Published specification; no individual contact |
| 2026-11-01 | SOURCE VERIFIED | VSDC v1.0.5 and CIS v1.0 PDFs retrieved from official RRA domain; checksums recorded above. | Official RRA URLs linked above | Document verification only; no RRA representative contacted |

Do not mark any operational policy CONFIRMED based only on this source review. For future confirmation, record the specific rule, RRA source section/page or written correspondence, date, and name/role of the person who confirmed it.
