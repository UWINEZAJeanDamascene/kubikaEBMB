#!/usr/bin/env node
'use strict';

/**
 * Static route inventory and middleware coverage check for the POS HTTP surface.
 * It intentionally audits route declarations (rather than controller names),
 * including chained router.route() declarations and router-level use() gates.
 *
 * Usage: node scripts/check-pos-route-security.js [--json]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROUTERS = [
  { file: 'routes/posRoutes.js', mount: '/api/pos' },
  { file: 'routes/tillRoutes.js', mount: '/api/tills' },
  { file: 'routes/salesLegacyRoutes.js', mount: '/api/sales-legacy' },
  { file: 'routes/creditNoteRoutes.js', mount: '/api/credit-notes' },
  { file: 'routes/posPaymentSettingsRoutes.js', mount: '/api/pos/payment-settings' },
  { file: 'routes/posPrintAgentRoutes.js', mount: '/api/pos/print-agent' },
  { file: 'routes/publicReceiptRoutes.js', mount: '/api/public/pos/receipts' },
];

// These endpoints authenticate in protocol-specific controllers/middleware.
// Keep this list narrow and reviewed; adding a route here is a security change.
const SPECIAL_AUTH = new Map([
  ['POST /api/pos/payments-v2/provider-webhooks/:provider/:companyId', 'Provider signature and provider event identity are checked by webhook service.'],
  ['POST /api/pos/auth/pin-login', 'Paired-device challenge and cashier PIN are validated by POS auth controller.'],
  ['GET /api/pos/registers/:registerId/cashiers', 'Paired-device token is required; cashier list is setup/bootstrap data.'],
  ['POST /api/pos/auth/offline-attempts', 'Paired-device token required; rate/lockout policy is enforced by auth controller.'],
  ['POST /api/sales-legacy/offline-sync/push', 'Device signature, enrolled-device state, live session and POS permissions are validated by route middleware.'],
  ['GET /api/sales-legacy/offline-sync/device-state', 'Paired-device contact token is validated by device middleware.'],
  ['POST /api/sales-legacy/offline-sync/device-state/wipe-ack', 'Paired-device contact token is validated by device middleware.'],
  ['GET /api/sales-legacy/offline-sync/pull', 'Cashier session and sell/payment permissions are validated by route middleware.'],
  ['POST /api/pos/print-agent/pair', 'One-time pairing code is validated by the pairing controller.'],
  ['POST /api/pos/print-agent/refresh', 'Agent credential is validated and rotated by the pairing controller.'],
  ['GET /api/pos/print-agent/agent/jobs/poll', 'Print-agent bearer credential is validated by requirePrintAgent.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/lease', 'Print-agent bearer credential and job lease state are validated.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/acknowledge', 'Print-agent bearer credential and job ownership/state are validated.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/fail', 'Print-agent bearer credential and job ownership/state are validated.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/uncertain', 'Print-agent bearer credential and job ownership/state are validated.'],
  ['POST /api/pos/print-agent/agent/drawer-authorizations/consume', 'Print-agent bearer credential, register binding, expiry, and single-use authorization are validated.'],
  ['POST /api/pos/print-agent/drawer-authorizations', 'Active cashier session, payment permission, register binding, and one-time drawer capability are validated.'],
  ['POST /api/pos/print-agent/drawer-authorizations/consume', 'Active cashier session, register binding, expiry, and single-use capability are validated.'],
  ['GET /api/public/pos/receipts/:token', 'Hashed, expiring public receipt capability token is checked by the receipt controller.'],
  ['GET /api/public/pos/receipts/:token/pdf', 'Hashed, expiring public receipt capability token is checked by the receipt controller.'],
  ['GET /api/pos/print-agent/admin/release', 'ERP session is required; release metadata is non-mutating.'],
  ['GET /api/pos/print-agent/admin/download', 'ERP session is required; installer download is non-mutating.'],
]);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Session control actions use verified session state or controller checks as
// their action gate, rather than a separate business capability string.
const SESSION_ACTION_AUTH = new Map([
  ['POST /api/pos/approvals', 'Approval service validates the requested POS action and manager-approval requirement.'],
  ['POST /api/pos/approval-requests', 'Controller validates action and company manager assignment.'],
  ['GET /api/pos/approval-managers', 'Only eligible company managers are returned.'],
  ['GET /api/pos/approval-requests/:requestId', 'Controller limits visibility to requester or assigned manager.'],
  ['POST /api/pos/users/:id/pin', 'Controller restricts change to active cashier or approved reset flow.'],
  ['POST /api/pos/auth/refresh', 'Controller validates the paired-device session and active refresh token before rotating it.'],
  ['POST /api/pos/auth/lock', 'Only active session may lock itself.'],
  ['POST /api/pos/auth/unlock', 'Only a locked session may unlock through PIN verification.'],
  ['POST /api/pos/auth/switch', 'Controller validates cashier assignment and PIN.'],
  ['POST /api/pos/auth/logout', 'Only active session may end itself.'],
  ['GET /api/pos/auth/me', 'Returns only the authenticated active/locked session.'],
  ['POST /api/pos/shifts/:shiftId/cash-movements', 'Cash movement capability is checked by requireCashMovementPermission.'],
]);

const NATIVE_IDEMPOTENCY = new Map([
  ['POST /api/pos/payments-v2/provider-webhooks/:provider/:companyId', 'Provider event ID and payment business key provide deduplication.'],
  ['POST /api/pos/auth/pin-login', 'PIN attempt is an authentication event; it must execute on each attempt.'],
  ['POST /api/pos/auth/offline-attempts', 'Monotonic device attempt sequence is the native replay boundary.'],
  ['POST /api/sales-legacy/offline-sync/push', 'Device operation ID and sequence are the durable sync idempotency boundary.'],
  ['POST /api/sales-legacy/offline-sync/device-state/wipe-ack', 'Device wipe acknowledgement has a device-scoped acknowledgement identity.'],
  ['POST /api/sales-legacy/offline-snapshot', 'One-use snapshot nonce/capability is the idempotency boundary; response is not cacheable.'],
  ['POST /api/pos/registers/:registerId/claim-code', 'One-time pairing code issuance/rotation is protected by register state and audit.'],
  ['POST /api/pos/print-agent/pair', 'One-time pairing code is the native credential boundary.'],
  ['POST /api/pos/print-agent/refresh', 'Agent credential rotation is the native credential boundary.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/lease', 'Print job ID and lease state are the native job boundary.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/acknowledge', 'Print job ID and state transition are the native job boundary.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/fail', 'Print job ID and state transition are the native job boundary.'],
  ['POST /api/pos/print-agent/agent/jobs/:jobId/uncertain', 'Print job ID, active lease token, and one-way uncertain state are the native job boundary.'],
  ['POST /api/pos/print-agent/agent/drawer-authorizations/consume', 'Drawer authorization row is atomically consumed once per register.'],
  ['POST /api/pos/print-agent/drawer-authorizations', 'Action identity and shared idempotency prevent duplicate authorization issuance on replay.'],
  ['POST /api/pos/print-agent/drawer-authorizations/consume', 'Drawer authorization row is atomically consumed once per cashier session.'],
]);

function matchingParen(source, open) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth === 0) return i; }
  }
  throw new Error(`Unclosed route declaration at offset ${open}`);
}

function splitArguments(source) {
  const parts = [];
  let start = 0;
  let paren = 0; let brace = 0; let bracket = 0;
  let quote = null;
  let lineComment = false; let blockComment = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]; const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren -= 1;
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;
    else if (ch === ',' && paren === 0 && brace === 0 && bracket === 0) {
      parts.push(source.slice(start, i).trim()); start = i + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function unquote(value) {
  const match = value.match(/^(['"])(.*)\1$/s);
  return match ? match[2] : null;
}

function scanRouter({ file, mount }) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const declarations = [];
  const inherited = [];
  const token = /router\.(use|get|post|put|patch|delete|options|head|route)\s*\(/g;
  let match;
  while ((match = token.exec(source))) {
    const methodOrUse = match[1];
    const open = source.indexOf('(', match.index);
    const close = matchingParen(source, open);
    const args = splitArguments(source.slice(open + 1, close));
    const afterIndex = close + 1;
    if (methodOrUse === 'use') {
      // A path-mounted child router applies only to its own path and must not
      // be treated as a router-wide auth layer for following declarations.
      const hasMountPath = unquote(args[0] || '') != null;
      if (!hasMountPath) inherited.push({ at: match.index, expr: args.join(', ') });
      token.lastIndex = afterIndex;
      continue;
    }
    if (methodOrUse === 'route') {
      const routePath = unquote(args[0] || '');
      if (routePath == null) throw new Error(`Dynamic router.route path in ${file}: ${args[0]}`);
      let cursor = close + 1;
      const chain = /^\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(/;
      while (true) {
        const rest = source.slice(cursor);
        const chained = rest.match(chain);
        if (!chained) break;
        const method = chained[1].toUpperCase();
        const callOpen = cursor + chained[0].lastIndexOf('(');
        const callClose = matchingParen(source, callOpen);
        const routeArgs = splitArguments(source.slice(callOpen + 1, callClose));
        declarations.push(makeRoute(method, routePath, routeArgs, match.index, file, mount, inherited));
        cursor = callClose + 1;
      }
      token.lastIndex = cursor;
      continue;
    }
    const routePath = unquote(args[0] || '');
    if (routePath == null) throw new Error(`Dynamic router.${methodOrUse} path in ${file}: ${args[0]}`);
    declarations.push(makeRoute(methodOrUse.toUpperCase(), routePath, args.slice(1), match.index, file, mount, inherited));
    token.lastIndex = afterIndex;
  }
  return declarations;
}

function makeRoute(method, routePath, args, offset, file, mount, inherited) {
  const before = inherited.filter((item) => item.at < offset).map((item) => item.expr);
  const explicit = args.join(', ');
  const middleware = [...before, explicit].filter(Boolean).join(', ');
  const fullPath = `${mount}${routePath === '/' ? '' : routePath}`;
  const key = `${method} ${fullPath}`;
  const hasPosSession = /requirePosSession|posSession(?:Read)?\s*\(|requireSamePosCashier|offlineSyncDeviceAccess|requireOnlinePosSession/.test(middleware);
  const hasDeviceAuth = /requireDevice\s*\(|requirePosDeviceContact\s*\(|requireDevice(?:\s|\(|,)/.test(middleware) || SPECIAL_AUTH.has(key);
  const hasErpAuth = /(?:^|[\s,(])protect(?:\s|,|\)|$)/.test(middleware);
  const authenticated = hasPosSession || hasDeviceAuth || hasErpAuth;
  const permission = /requirePermission|requireAnyPosPermission|requireAssignedPermissions|requirePermissionOrRoles|can[A-Z]\w*|authorizeCreditNote|Permission|posSession(?:Read)?\s*\(|requireCashMovementPermission/.test(middleware);
  const idem = /idempotentHandler|idem\w*\s*\(|idempotent/i.test(middleware) || /posSession\(/.test(middleware);
  const specialAuth = SPECIAL_AUTH.get(key) || SESSION_ACTION_AUTH.get(key) || null;
  const nativeIdempotency = NATIVE_IDEMPOTENCY.get(key) || null;
  const posSessionBound = /requirePosSession|posSession(?:Read)?\s*\(|requireSamePosCashier|offlineSyncDeviceAccess|requireOnlinePosSession/.test(middleware);
  const deviceBound = /requireDevice\s*\(|requirePosDeviceContact\s*\(|offlineSyncDeviceAccess/.test(middleware)
    || Boolean(specialAuth && /device|agent|provider|pairing/i.test(specialAuth));
  const routeRateLimited = /rateLimit|rateLimiter|publicReceiptLimit|limiter\s*\(/i.test(middleware);
  const rateLimit = /posCredentialRateLimit/i.test(middleware)
    ? 'STRICT_CREDENTIAL_LIMIT'
    : /posDevicePairingRateLimit/i.test(middleware)
      ? 'STRICT_PAIRING_LIMIT'
      : routeRateLimited ? 'ROUTE_RATE_LIMITED' : (/pin-login|offline-attempts/.test(routePath) ? 'LOCAL_LOCKOUT_ONLY_NO_REQUEST_LIMIT' : 'NO_ROUTE_RATE_LIMIT');
  const routeValidator = /(?:validate(?:Body|Params|Query|Request)?(?:\s*\(|\b)|schema(?:Validator)?\s*\(|celebrate\s*\(|zod\b|\b(?:body|param|query)\s*\()/i.test(middleware);
  const shiftRelevant = /\/shifts|direct-sale|payments|refund|credit-accounts|cash-movements|drawer|offline-(?:sync|snapshot)|held-sales|vouchers\/(?:reserve|release)|discounts\/apply/i.test(routePath);
  const authKinds = [hasErpAuth && 'ERP_SESSION', hasPosSession && 'POS_SESSION', hasDeviceAuth && 'DEVICE_OR_PROTOCOL'].filter(Boolean);
  const authentication = authKinds.length > 1 ? authKinds.join('+') : authKinds[0] || 'MISSING';
  const handler = args.length ? args[args.length - 1].replace(/^idem\w*\((.*)\)$/s, '$1') : '';
  return {
    method, path: fullPath, key, file, middleware: middleware.replace(/\s+/g, ' ').trim(),
    authentication: authenticated ? authentication : 'MISSING',
    handler,
    authorization: permission ? 'ROUTE_PERMISSION' : specialAuth ? 'ACTION_GATED' : 'MISSING',
    idempotency: idem ? 'SHARED_IDEMPOTENCY' : nativeIdempotency ? 'NATIVE_BOUNDARY' : MUTATING.has(method) ? 'MISSING' : 'READ_ONLY',
    specialAuth,
    nativeIdempotency,
    tenantScope: posSessionBound ? 'POS_SESSION_COMPANY_BOUND' : deviceBound ? 'DEVICE_OR_PROTOCOL_TENANT_BOUNDARY' : /attachCompanyId/.test(middleware) ? 'ERP_COMPANY_CONTEXT_BOUND' : 'CONTROLLER_TENANT_SCOPE_REQUIRED',
    registerScope: posSessionBound ? 'POS_SESSION_REGISTER_BOUND' : deviceBound ? 'DEVICE_OR_PROTOCOL_REGISTER_BOUNDARY' : 'CONTROLLER_REGISTER_SCOPE_REQUIRED',
    shiftScope: shiftRelevant ? 'SHIFT_RELEVANT_CONTROLLER_REVIEW' : 'NOT_SHIFT_SCOPED_OR_CONTROLLER_REVIEW',
    inputValidation: routeValidator ? 'ROUTE_VALIDATOR' : 'CONTROLLER_VALIDATION_REVIEW_REQUIRED',
    rateLimit,
    offset,
  };
}

function audit() {
  const routes = ROUTERS.flatMap(scanRouter);
  const seen = new Set();
  for (const route of routes) {
    if (seen.has(route.key)) route.finding = 'DUPLICATE_ROUTE_DECLARATION';
    seen.add(route.key);
    if (route.authentication === 'MISSING' && !route.specialAuth) route.finding ||= 'MISSING_AUTHENTICATION';
    if (route.authorization === 'MISSING' && !route.specialAuth) route.finding ||= 'MISSING_ROUTE_AUTHORIZATION';
    if (MUTATING.has(route.method) && route.idempotency === 'MISSING') route.finding ||= 'MISSING_IDEMPOTENCY_OR_DOCUMENTED_NATIVE_BOUNDARY';
    if (route.specialAuth && route.authentication === 'MISSING') route.authentication = 'SPECIAL_PROTOCOL_AUTH';
  }
  return routes;
}

function main() {
  const routes = audit();
  const json = process.argv.includes('--json');
  const markdown = process.argv.includes('--markdown');
  if (json) {
    process.stdout.write(`${JSON.stringify(routes.map(({ offset, ...route }) => route), null, 2)}\n`);
  } else if (markdown) {
    const escaped = (value) => String(value || '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    console.log('# POS HTTP route security inventory');
    console.log('');
    console.log(`Generated from route declarations by \`node scripts/check-pos-route-security.js --markdown\`. Inventory: **${routes.length} route methods** across POS, till, legacy sales, credit-note, payment-settings, print-agent, and public-receipt routers.`);
    console.log('');
    console.log('This is a static route-middleware inventory. POS session and device labels prove identity bindings only; they do not prove that handlers scope every object ID to that company/register. Shift checks, controller validation, and resource ownership still require handler/service review. Rate-limit status records router middleware only; counters are process-local (see `docs/pos/route-rate-limits.md`).');
    console.log('');
    const countBy = (field) => routes.reduce((counts, route) => {
      const value = route[field]; counts[value] = (counts[value] || 0) + 1; return counts;
    }, {});
    const rateCounts = countBy('rateLimit');
    console.log('## Review summary');
    console.log('');
    console.log(`- Authentication and authorization/replay scan: ${routes.length} routes; ${routes.filter((route) => route.finding).length} missing declarations. ${countBy('authorization').ROUTE_PERMISSION || 0} routes have explicit permission middleware and ${countBy('authorization').ACTION_GATED || 0} use a documented action/protocol gate.`);
    console.log(`- Company/register identity at the router: ${countBy('tenantScope').POS_SESSION_COMPANY_BOUND || 0} POS-session-bound, ${countBy('tenantScope').DEVICE_OR_PROTOCOL_TENANT_BOUNDARY || 0} device/protocol-bound, ${countBy('tenantScope').CONTROLLER_TENANT_SCOPE_REQUIRED || 0} require handler-level tenant review. This does not prove target object ownership.`);
    console.log(`- Shift-sensitive paths: ${countBy('shiftScope').SHIFT_RELEVANT_CONTROLLER_REVIEW || 0} need handler/service review for open-shift and shift ownership; the session middleware itself does not require an open shift.`);
    console.log(`- Validation: ${countBy('inputValidation').ROUTE_VALIDATOR || 0} have a recognized route validator; ${countBy('inputValidation').CONTROLLER_VALIDATION_REVIEW_REQUIRED || 0} rely on validation that must be reviewed in handlers/services.`);
    console.log(`- Rate limits: ${rateCounts.ROUTE_RATE_LIMITED || 0} routes have router-level limiting; ${rateCounts.LOCAL_LOCKOUT_ONLY_NO_REQUEST_LIMIT || 0} have local PIN lockout only; ${rateCounts.NO_ROUTE_RATE_LIMIT || 0} have no route-level limiter.`);
    console.log(`- Tighter limits: ${rateCounts.STRICT_CREDENTIAL_LIMIT || 0} credential-attempt routes share a 20-attempt/15-minute cap; ${rateCounts.STRICT_PAIRING_LIMIT || 0} pairing routes use a 10-attempt/15-minute cap. Defaults are environment-configurable; counters are process-local.`);
    console.log('- POS session middleware verifies active company, user, register, device, and session identity, and rejects a mismatched ERP tenant when both credentials are present. It does not enforce object-ID ownership or open-shift state globally.');
    console.log('- This report is a complete static inventory of the listed route declarations, not a runtime proof of controller/service behavior.');
    console.log('');
    console.log('| Route | Authentication | Permission/action gate | Handler | Company scope | Register scope | Open-shift check | Input validation | Rate limit | Replay boundary | Middleware / reviewed gate |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const route of routes) {
      const gate = route.specialAuth ? `${route.middleware} — ${route.specialAuth}` : route.middleware;
      console.log(`| \`${route.method} ${route.path}\` | ${route.authentication} | ${route.authorization} | \`${escaped(route.handler)}\` | ${route.tenantScope} | ${route.registerScope} | ${route.shiftScope} | ${route.inputValidation} | ${route.rateLimit} | ${route.idempotency} | ${escaped(gate)} |`);
    }
    console.log('');
    console.log(`Scanner result: **${routes.filter((route) => route.finding).length} missing authentication/authorization/replay declarations**. This scanner does not certify controller-level tenant/resource ownership, validation, shift checks, or effective rate limiting.`);
  } else {
    const counts = routes.reduce((out, route) => { out[route.method] = (out[route.method] || 0) + 1; return out; }, {});
    console.log(`POS route security inventory: ${routes.length} routes (${Object.entries(counts).map(([method, count]) => `${method} ${count}`).join(', ')})`);
    console.log('METHOD  AUTH                 PERMISSION       IDEMPOTENCY       ROUTE');
    for (const route of routes) {
      const marker = route.finding ? 'FAIL' : 'PASS';
      console.log(`${marker.padEnd(5)} ${route.method.padEnd(6)} ${route.authentication.padEnd(20)} ${route.authorization.padEnd(16)} ${route.idempotency.padEnd(17)} ${route.key} [${route.file}]`);
      if (route.finding) console.log(`      ${route.finding}: ${route.middleware || '(no route middleware)'}`);
    }
  }
  const failures = routes.filter((route) => route.finding);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { audit, ROUTERS };
