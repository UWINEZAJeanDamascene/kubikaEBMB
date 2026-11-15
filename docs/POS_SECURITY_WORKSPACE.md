# POS security and audit workspace

The POS Back Office exposes audit history at `/pos/admin/audit` and security controls at `/pos/admin/security`. Both pages and their APIs use the authenticated company context. Till/front-office pages are not used to administer these settings.

## Audit history

The audit page supports filtering by date, actor, register, device, event, action ID, entity type/reference, outcome, severity, and correlation ID. Selecting a row opens its sanitized details and, when a correlation ID exists, the related event sequence. Entity links are shown only for supported entity types. CSV export uses the same filters, exports a fixed set of safe fields, masks nothing by exposing no raw credentials or metadata outside the allowlist, and escapes spreadsheet formula prefixes.

Audit viewing, export, and integrity verification are separate capabilities:

- `pos.admin.audit:read`
- `pos.admin.audit:export`
- `pos.admin.audit:verify`

Reads and exports append their own audit events. Integrity verification reports stream/checkpoint status, the highest verified sequence and any break; older rows created before hash chaining are explicitly identified as unverified.

## Security workspace

`/pos/admin/security` provides company-level PIN failure/lockout settings, idle-session lock timing, one-register-per-cashier policy, risk thresholds and lookback, duplicate-attempt/replay reports, active POS sessions, and audit-chain verification. Security reports read at most the configured `QUERY_MAX_ROWS` audit events (500 by default); the risk report marks results that reach this cap as potentially truncated.

PIN and session policy writes are enforced by the server. Changing PIN failure limits affects subsequent register PIN failures. Ending a session marks it ended in the database and records a `SESSION_ENDED` audit event in the same transaction; the till must authenticate again on its next request.

Permissions are distinct:

- `pos.admin.security:read` reads security settings and reports.
- `pos.admin.security:update` changes security settings.
- `pos.admin.security.sessions:read` lists active/locked sessions and devices.
- `pos.admin.security.sessions:revoke` ends a session or revokes a device.
- `pos.admin.audit:verify` runs integrity verification.

The seeded store-manager/owner roles receive the security and session capabilities; cashier roles do not. Existing system roles need to be synchronized after deploying the updated seed definitions. Verify role assignments in the POS role editor before rollout.

## Database rollout

The security settings fields use `system_settings.pos_security_settings`, `pos_idle_lock_minutes`, and `pos_single_register_session`. Apply the additive security migration and regenerate Prisma Client:

```powershell
npm run db:migrate:deploy
npx prisma generate --schema=./prisma/schema.prisma
```

Audit-chain verification also requires the existing `20261111130000_pos_audit_integrity` migration. If its tables are absent, the API reports that verification is unavailable; it does not claim a successful check.
