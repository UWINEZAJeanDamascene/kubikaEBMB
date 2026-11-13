# POS audit integrity

POS audit evidence is append-only after migration `20261111130000_pos_audit_integrity` is applied.

## Chain format

Each company has independent back-office evidence and each register has its own stream. The stream identifier is `<company-id>:backoffice` or `<company-id>:register:<register-id>`. A stream starts at sequence `1` with a 64-character zero genesis hash. Every row stores the previous row hash and a SHA-256 digest of canonical JSON containing its immutable event identity, tenant/register/user references, event name, sanitized metadata, IP, stream, sequence, previous hash, and creation time. Canonical JSON sorts object keys, serializes dates as ISO-8601 UTC, and serializes big integers as decimal strings.

`writePosAuditLog` takes a PostgreSQL transaction-scoped advisory lock for the stream before reading its latest sequence and inserting the next row. When given a business transaction client, it writes within that transaction; standalone writes create a transaction themselves. A unique company/stream/sequence index is the final concurrency guard.

## Checkpoints and verification

The worker creates one checkpoint per active stream for the previous UTC day at 00:15 UTC. A checkpoint stores the last event before the next UTC day, its sequence and hash, and a separate SHA-256 digest over the checkpoint fields. Re-running a date is idempotent. The verifier is `services/posAuditIntegrityService.verifyPosAuditIntegrity({ companyId, streamId? })`; it checks sequence continuity, previous hashes, row digests, checkpoint digests, and checkpoint references. It returns the number of older, unhashed rows separately as `legacyUnverifiedRows`; historical rows are not retroactively represented as verified.

## Database protection and retention

Database triggers reject normal `UPDATE`, `DELETE`, and `TRUNCATE` statements against both audit rows and checkpoints. Another trigger requires every new audit row to provide a valid chain entry. The migration removes the old company, register, and user foreign keys from audit rows so deleting a related business record cannot cascade into or rewrite the evidence. Those IDs remain historical references and may no longer resolve after the referenced business record is removed.

The triggers protect against application and ordinary database DML. A database superuser can disable triggers or alter the schema; deployments needing protection against privileged database operators should export signed checkpoints to an independently controlled storage system. Checkpoint creation is currently internal worker functionality; no manager-facing verification endpoint or external anchoring UI is added in this change.

## Migration

Review `prisma/migrations/20261111130000_pos_audit_integrity/migration.sql` and apply it through the project's normal migration process. It has not been applied by this implementation. Existing audit rows remain intact and unhashed; all rows inserted after application must be chained.
