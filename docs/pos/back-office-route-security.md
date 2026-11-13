# POS Back Office route security matrix

The complete generated route-by-route inventory (including authentication, permission/action gate, company/register scope, open-shift review, validation, rate limit, and replay boundary) is in [POS_ROUTE_SECURITY_INVENTORY.md](../POS_ROUTE_SECURITY_INVENTORY.md). Regenerate it with `npm run pos:route-security-report` from the backend package.

This matrix is the authorization map for ERP-authenticated management routes. Routes under `/api/pos/admin/*` inherit `protect` from `router.use(protect)` in `routes/posRoutes.js`. They use the verified ERP company context; handlers must still scope every requested row by that company. Mutations use the shared `idempotentHandler` unless marked read-only.

## POS management routes

| Method and route | Required permission | Additional boundary |
| --- | --- | --- |
| `GET /api/pos/register-settings` | `pos.admin:settings` | Company-scoped settings |
| `PUT /api/pos/register-settings` | `pos.admin:settings` | Idempotent, audited settings update |
| `GET /api/pos/register-settings/payment-methods` | `pos.admin:settings` | Company-scoped settings |
| `PUT /api/pos/register-settings/payment-methods` | `pos.admin:settings` | Idempotent, audited settings update |
| `POST /api/pos/register-settings/receipt-branch/:branchId/reset` | `pos.admin:settings` | Idempotent; branch must belong to company |
| `GET /api/pos/admin/discount-settings` | `pos.admin:settings` | Company-scoped settings |
| `GET /api/pos/admin/discount-settings/roles` | `pos.admin:settings` | Returns roles for active company |
| `PUT /api/pos/admin/discount-settings` | `pos.admin:settings` | Idempotent, audited settings update |
| `PATCH /api/pos/admin/registers/:registerId/discount-settings` | `pos.admin:registers` | Register must belong to company; idempotent |
| `GET /api/pos/admin/accounting-profile` | `pos.admin:settings` | Company-scoped profile |
| `PUT /api/pos/admin/accounting-profile` | `pos.admin:settings` | Idempotent, audited profile update |
| `GET /api/pos/admin/overview` | `pos.admin:view` | Company-scoped overview |
| `GET /api/pos/admin/shifts` | `pos.admin:shifts` | Company-scoped shift list |
| `DELETE /api/pos/admin/shifts/:shiftId` | `pos.admin:shifts` | Only empty closed shifts; idempotent |
| `GET /api/pos/admin/audit` | `pos.admin.audit:read` | Filters and results are company-scoped |
| `GET /api/pos/admin/audit/export.csv` | `pos.admin.audit:export` | Masked company-scoped CSV; read/export audit event |
| `GET /api/pos/admin/security/settings` | `pos.admin.security:read` | Company-scoped security settings |
| `PUT /api/pos/admin/security/settings` | `pos.admin.security:update` | Idempotent; before/after audit values |
| `GET /api/pos/admin/security/audit-integrity` | `pos.admin.audit:verify` | Read-only integrity verification |
| `GET /api/pos/admin/security/duplicate-attempts` | `pos.admin.security:read` | Company-scoped report |
| `GET /api/pos/admin/security/risk-report` | `pos.admin.security:read` | Company-scoped report |
| `GET /api/pos/admin/approval-requests` | `pos.admin:approvals` | Company-scoped; assignment/action eligibility checked |
| `POST /api/pos/admin/approval-requests/:requestId/decision` | `pos.admin:approvals` | Company/assignment/action checks; idempotent and audited |
| `GET /api/pos/admin/approval-policies` | `pos.admin:approvals` | Company-scoped policy list |
| `PUT /api/pos/admin/approval-policies/:action` | `pos.admin:approvals` | Idempotent, audited policy update |
| `GET /api/pos/admin/offline-exceptions` | `pos.admin:approvals` | Company-scoped exception queue |
| `POST /api/pos/admin/offline-exceptions/:exceptionId/resolve` | `pos.admin:approvals` | Company-scoped resolution; idempotent and audited |
| `GET /api/pos/admin/idempotency-review` | `pos.admin:approvals` | Company-scoped review queue |
| `POST /api/pos/admin/idempotency-review/:recordId/resolve` | `pos.admin:approvals` | Company-scoped resolution; idempotent and audited |
| `GET /api/pos/admin/offline-monitoring` | `pos.admin:reports` | Company-scoped reporting |
| `GET /api/pos/admin/discount-reports` | `pos.admin:reports` | Company-scoped reporting |
| `GET /api/pos/admin/accounting-postings` | `pos.admin:reports` | Company-scoped postings |
| `POST /api/pos/admin/accounting-postings/:postingId/retry` | `pos.admin:reports` | Company-scoped posting; idempotent |
| `GET /api/pos/admin/accounting-reports` | `pos.admin:reports` | Company-scoped reporting |

## Register, device, and printer management

The following routes are mounted under `/api/tills` and `/api/pos/print-agent`. Register/device administration requires ERP `protect` plus `pos.admin:registers`; printer pairing/configuration requires ERP `protect` plus `pos.admin:printers`. Mutations are idempotent. Register and device IDs are resolved within the active company.

| Method and route | Required permission |
| --- | --- |
| `GET /api/tills/registers` | `pos.admin:registers` |
| `POST /api/tills/registers` | `pos.admin:registers` |
| `POST /api/tills/registers/claim` | `pos.admin:registers` |
| `PATCH /api/tills/registers/:registerId/branch` | `pos.admin:registers` |
| `PATCH /api/tills/registers/:registerId/training-mode` | `pos.admin:registers` |
| `POST /api/tills/registers/:registerId/claim-code` | `pos.admin:registers` |
| `POST /api/tills/registers/:registerId/revoke-device` | `pos.admin:registers` |
| `DELETE /api/tills/registers/:registerId` | `pos.admin:registers` |
| `GET /api/tills/devices` | `pos.admin:registers` |
| `PATCH /api/tills/devices/:deviceId/status` | `pos.admin:registers` |
| `POST /api/tills/devices/:deviceId/wipe` | `pos.admin:registers` |
| `POST /api/pos/print-agent/admin/pairings` | `pos.admin:printers` |
| `GET /api/pos/print-agent/admin/agents` | `pos.admin:printers` |
| `POST /api/pos/print-agent/admin/agents/:agentId/revoke` | `pos.admin:printers` |
| `POST /api/pos/print-agent/admin/printers` | `pos.admin:printers` |
| `POST /api/pos/print-agent/admin/jobs` | `pos.admin:printers` |
| `GET /api/pos/print-agent/admin/jobs` | `pos.admin:printers` |

## Permission rollout and UI

Audit read, CSV export, integrity verification, security report reads, and security settings updates are independent capabilities:

| Capability | Permission | Legacy compatibility |
| --- | --- | --- |
| Audit screen and filtered data | `pos.admin.audit:read` | `pos.admin:audit` grants read only |
| Masked CSV export | `pos.admin.audit:export` | No broad legacy fallback |
| Audit integrity verification | `pos.admin.audit:verify` | No broad legacy fallback |
| Security reports/settings view | `pos.admin.security:read` | `pos.admin:security` grants read only |
| Change security policy | `pos.admin.security:update` | No broad legacy fallback |

System managers and owners receive explicit grants in the accompanying migration and role seed. Custom POS roles can be assigned the same capabilities through role permissions. The UI hides export, verification, and update actions unless the matching permission is present; the API remains authoritative.

The route scanner validates authentication, authorization, rate limiting, and mutation idempotency on every declared POS route. Run `npm run pos:route-security-report` to inspect the generated full route inventory. The scanner cannot prove tenant ownership inside controller queries; that remains covered by service-level company guards and route-specific tests.
