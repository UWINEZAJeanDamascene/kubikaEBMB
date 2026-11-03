/**
 * Seeds system roles into PostgreSQL.
 * Run this before creating platform admin or any users.
 *   node scripts/seedSystemRoles.js
 */
require('dotenv').config();

const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const CASHIER_POS_ROLE_PERMISSIONS = [
  { resource: 'pos.till', actions: ['sell', 'cash_move', 'close_shift', 'discount', 'receive_account_payment', 'open_shift'] },
  { resource: 'products', actions: ['read'] },
  { resource: 'clients', actions: ['read', 'create'] },
];
const SUPERVISOR_POS_ROLE_PERMISSIONS = [
  ...CASHIER_POS_ROLE_PERMISSIONS,
  { resource: 'pos.till', actions: ['refund', 'void', 'no_sale', 'reprint', 'credit_sell'] },
  { resource: 'pos.admin', actions: ['shifts', 'approvals'] },
];
const STORE_MANAGER_POS_ROLE_PERMISSIONS = [
  ...SUPERVISOR_POS_ROLE_PERMISSIONS,
  { resource: 'pos.admin', actions: ['view', 'reports', 'cashiers', 'registers', 'printers', 'settings', 'shifts', 'approvals', 'audit'] },
  { resource: 'tills', actions: ['read', 'create'] },
  // Registers are assigned to the shop's active branch/warehouse records.
  { resource: 'warehouses', actions: ['read'] },
  { resource: 'ebm', actions: ['read'] },
  { resource: 'pos.shift', actions: ['settings'] },
  { resource: 'pos.payment', actions: ['settings', 'manual_confirm'] },
  { resource: 'pos.giftcard', actions: ['manage'] },
];
const OWNER_POS_ROLE_PERMISSIONS = [
  ...STORE_MANAGER_POS_ROLE_PERMISSIONS,
  { resource: 'pos.admin', actions: ['roles'] },
];

const systemRoles = [
  {
    name: 'cashier',
    description: 'POS cashier access: sell, manage drawer movements, discounts within limits, and close own shift',
    is_system_role: true,
    permissions: CASHIER_POS_ROLE_PERMISSIONS,
  },
  {
    name: 'supervisor',
    description: 'POS supervisor access with sensitive till approvals and shift review',
    is_system_role: true,
    permissions: SUPERVISOR_POS_ROLE_PERMISSIONS,
  },
  {
    name: 'owner',
    description: 'POS owner access including roles, printers, and all POS settings',
    is_system_role: true,
    permissions: OWNER_POS_ROLE_PERMISSIONS,
  },
  {
    name: 'store_manager',
    description: 'POS manager with full Back Office access except POS role administration',
    is_system_role: true,
    permissions: STORE_MANAGER_POS_ROLE_PERMISSIONS,
  },
  {
    name: 'platform_admin',
    description: 'Platform administrator with full system access',
    is_system_role: true,
    permissions: [
      { resource: '*', actions: ['*'] } // Full access to everything
    ]
  },
  {
    name: 'admin',
    description: 'Company administrator with full company access',
    is_system_role: true,
    permissions: [
      { resource: '*', actions: ['read', 'create', 'update', 'delete', 'approve', 'post', 'confirm', 'admin'] },
      { resource: 'payroll', actions: ['read', 'create', 'update', 'delete', 'approve', 'post', 'pay', 'remit', 'export', 'file', 'admin'] },
    ]
  },
  {
    name: 'manager',
    description: 'Manager with full POS Back Office access except POS role administration, plus team operations',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read', 'create', 'update'] },
      { resource: 'sales_invoices', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'purchase_orders', actions: ['read', 'create', 'update', 'approve'] },
      { resource: 'users', actions: ['read', 'create', 'update'] },
      { resource: 'projects', actions: ['read', 'create', 'update', 'close', 'reopen'] },
      { resource: 'payroll', actions: ['read', 'create', 'update'] },
      { resource: 'credit_notes', actions: ['read', 'create', 'update', 'delete', 'approve'] },
      { resource: 'reports', actions: ['read'] },
      ...STORE_MANAGER_POS_ROLE_PERMISSIONS,
    ]
  },
  {
    name: 'stock_manager',
    description: 'Stock manager with inventory control access',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'stock', actions: ['read', 'create', 'update'] },
      { resource: 'suppliers', actions: ['read', 'create', 'update'] },
      { resource: 'warehouses', actions: ['read', 'create', 'update'] },
      { resource: 'stock_transfers', actions: ['read', 'create', 'update'] },
      { resource: 'projects', actions: ['read', 'update'] }
    ]
  },
  {
    name: 'sales',
    description: 'Sales representative',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read'] },
      { resource: 'clients', actions: ['read', 'create', 'update'] },
      { resource: 'sales_invoices', actions: ['read', 'create', 'update'] },
      { resource: 'quotations', actions: ['read', 'create', 'update'] },
      { resource: 'delivery_notes', actions: ['read', 'create'] },
      { resource: 'credit_notes', actions: ['read', 'create', 'update', 'delete'] },
      { resource: 'ar_receipts', actions: ['read', 'create'] }
    ]
  },
  {
    name: 'viewer',
    description: 'Read-only access to all modules',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read'] },
      { resource: 'stock', actions: ['read'] },
      { resource: 'sales_invoices', actions: ['read'] },
      { resource: 'purchase_orders', actions: ['read'] },
      { resource: 'clients', actions: ['read'] },
      { resource: 'suppliers', actions: ['read'] },
      { resource: 'reports', actions: ['read'] },
      { resource: 'quotations', actions: ['read'] },
      { resource: 'journal_entries', actions: ['read'] },
      { resource: 'chart_of_accounts', actions: ['read'] },
      { resource: 'projects', actions: ['read'] }
    ]
  },
  {
    name: 'accountant',
    description: 'Accounting and financial access',
    is_system_role: true,
    permissions: [
      { resource: 'journal_entries', actions: ['read', 'create', 'update', 'post'] },
      { resource: 'chart_of_accounts', actions: ['read', 'create', 'update'] },
      { resource: 'sales_invoices', actions: ['read', 'update'] },
      { resource: 'purchase_orders', actions: ['read'] },
      { resource: 'reports', actions: ['read', 'create'] },
      { resource: 'bank_accounts', actions: ['read', 'create', 'update'] },
      { resource: 'ar_receipts', actions: ['read', 'create', 'update', 'reverse'] },
      { resource: 'ap_payments', actions: ['read', 'create', 'update'] },
      { resource: 'expenses', actions: ['read', 'create', 'update'] },
      { resource: 'budgets', actions: ['read', 'create', 'update'] },
      { resource: 'projects', actions: ['read'] },
      { resource: 'payroll', actions: ['read', 'create', 'update', 'approve', 'post', 'pay', 'remit', 'export', 'file'] },
      { resource: 'periods', actions: ['read', 'update', 'close'] }
    ]
  },
  {
    name: 'purchaser',
    description: 'Purchase order and supplier management',
    is_system_role: true,
    permissions: [
      { resource: 'products', actions: ['read'] },
      { resource: 'suppliers', actions: ['read', 'create', 'update'] },
      { resource: 'purchase_orders', actions: ['read', 'create', 'update', 'approve'] },
      { resource: 'grn', actions: ['read', 'create', 'update', 'confirm'] },
      { resource: 'purchase_returns', actions: ['read', 'create', 'update'] },
      { resource: 'ap_payments', actions: ['read'] }
    ]
  },
  {
    name: 'warehouse_manager',
    description: 'Warehouse and logistics management',
    is_system_role: true,
    permissions: [
      { resource: 'stock', actions: ['read', 'create', 'update'] },
      { resource: 'warehouses', actions: ['read', 'create', 'update'] },
      { resource: 'stock_transfers', actions: ['read', 'create', 'update'] },
      { resource: 'stock_audits', actions: ['read', 'create', 'update'] },
      { resource: 'delivery_notes', actions: ['read', 'create', 'update'] },
      { resource: 'pick_packs', actions: ['read', 'create', 'update'] },
      { resource: 'projects', actions: ['read', 'update'] }
    ]
  }
];

async function syncSystemRoles() {
  const results = { created: 0, updated: 0 };
  for (const roleData of systemRoles) {
    const existing = await prisma.role.findFirst({
      where: { name: roleData.name, isSystemRole: true },
    });
    if (existing) {
      // Update existing role with new permissions
      await prisma.role.update({
        where: { id: existing.id },
        data: {
          description: roleData.description,
          permissions: roleData.permissions,
        },
      });
      results.updated += 1;
      continue;
    }

    await prisma.role.create({
      data: {
        id: generateObjectId(),
        name: roleData.name,
        description: roleData.description,
        isSystemRole: true,
        permissions: roleData.permissions,
      },
    });
    results.created += 1;
  }

  return results;
}

async function run() {
  await connectPrisma();

  console.log('Seeding system roles...\n');
  const results = await syncSystemRoles();

  console.log(`\nSystem roles synced successfully (${results.created} created, ${results.updated} updated).`);
  await disconnectPrisma();
  process.exit(0);
}

if (require.main === module) {
  run().catch(err => {
    console.error('Error seeding roles:', err);
    process.exit(1);
  });
}

module.exports = { systemRoles, syncSystemRoles };
