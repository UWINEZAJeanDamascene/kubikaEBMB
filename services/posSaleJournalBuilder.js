'use strict';

const { BankAccount } = require('../models/BankAccount');
const JournalService = require('./journalService');
const posAccountingProfileService = require('./posAccountingProfileService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { buildSaleJournalEntries } = require('./posAccountingBuilders');

async function buildPosSaleJournalEntries({
  companyId,
  userId,
  invoice,
  register,
  tenders,
  lines,
  totalAmount,
  subtotal,
  totalDiscount,
  taxAmount,
  amountPaid,
  amountOutstanding,
  cogsAmount,
  loyaltyEarned = 0,
  paymentFlow = 'LEGACY',
}) {
  const paymentAccounts = new Map();
  for (const tender of tenders) {
    if (!['bank_transfer', 'cheque', 'mobile_money'].includes(tender.paymentMethod)) continue;
    const manualPosMobileMoney = paymentFlow === 'PAYMENTS_V2'
      && tender.paymentMethod === 'mobile_money'
      && ['momo', 'airtel'].includes(String(tender.provider || '').toLowerCase());
    const profileMappedV2Tender = paymentFlow === 'PAYMENTS_V2'
      && ['bank_transfer', 'cheque'].includes(tender.paymentMethod);
    if (manualPosMobileMoney || profileMappedV2Tender) continue;
    if (!tender.bankAccountId) {
      const error = new Error(`Select the bank or mobile money account used for ${tender.paymentMethod}`);
      error.code = 'POS_PAYMENT_ACCOUNT_REQUIRED';
      throw error;
    }
    const accountKey = String(tender.bankAccountId);
    if (!paymentAccounts.has(accountKey)) {
      let account;
      try {
        account = await BankAccount.findOne({
          _id: tender.bankAccountId,
          company: companyId,
          isActive: true,
        }).select('_id ledgerAccountId name').lean();
      } catch (error) {
        error.accountingPostingFailure = true;
        throw error;
      }
      if (!account) {
        const error = new Error('A selected payment account is unavailable');
        error.code = 'POS_PAYMENT_ACCOUNT_INVALID';
        throw error;
      }
      paymentAccounts.set(accountKey, account);
    }
  }

  let accountingProfile;
  try {
    accountingProfile = await posAccountingProfileService.getProfile(String(companyId));
  } catch (error) {
    error.accountingPostingFailure = true;
    throw error;
  }
  const scope = {
    tillType: String(register.systemTillType || 'retail').toLowerCase(),
    registerId: String(register.id || register._id),
  };
  const serviceCharge = invoice.posCheckoutPayload?.restaurantCheckoutSnapshot?.serviceCharge || null;
  const serviceChargeAmount = Number(serviceCharge?.amountRwf || 0);
  const mappedAccount = async (profileKey, moduleName, mappingKey, fallback) => {
    try {
      return posAccountingProfileService.resolveAccount(accountingProfile, profileKey, scope)
        || await JournalService.getMappedAccountCode(companyId, moduleName, mappingKey, fallback);
    } catch (error) {
      error.accountingPostingFailure = true;
      throw error;
    }
  };
  let accounts;
  try {
    accounts = {
      posRegisterCash: await mappedAccount('posRegisterCash', 'cash', 'cashOnHand', DEFAULT_ACCOUNTS.posRegisterCash),
      cardClearing: await mappedAccount('cardClearing', 'cash', 'cashAtBank', DEFAULT_ACCOUNTS.cashAtBank),
      mtnMoMo: await mappedAccount('mtnMoMo', 'cash', 'mtnMoMo', DEFAULT_ACCOUNTS.mtnMoMo),
      airtelMoney: await mappedAccount('airtelMoney', 'cash', 'airtelMoney', DEFAULT_ACCOUNTS.airtelMoney),
      cashAtBank: await mappedAccount('cashAtBank', 'cash', 'cashAtBank', DEFAULT_ACCOUNTS.cashAtBank),
      accountsReceivable: await mappedAccount('accountsReceivable', 'sales', 'accountsReceivable', DEFAULT_ACCOUNTS.accountsReceivable),
      customerAdvances: await mappedAccount('customerAdvances', 'sales', 'customerAdvances', DEFAULT_ACCOUNTS.customerAdvances),
      giftCardLiability: await mappedAccount('giftCardLiability', 'sales', 'giftCardLiability', DEFAULT_ACCOUNTS.deferredRevenue),
      chequesInHand: posAccountingProfileService.resolveAccount(accountingProfile, 'chequesInHand', scope),
      storeCreditLiability: posAccountingProfileService.resolveAccount(accountingProfile, 'storeCreditLiability', scope),
      loyaltyWalletLiability: posAccountingProfileService.resolveAccount(accountingProfile, 'loyaltyWalletLiability', scope),
      loyaltyPointsLiability: posAccountingProfileService.resolveAccount(accountingProfile, 'loyaltyPointsLiability', scope),
      loyaltyRewardsExpense: await mappedAccount('loyaltyRewardsExpense', 'expenses', 'marketing', DEFAULT_ACCOUNTS.marketing),
      inventory: await mappedAccount('inventory', 'purchases', 'inventory', DEFAULT_ACCOUNTS.inventory),
      salesRevenue: await mappedAccount('salesRevenue', 'sales', 'salesRevenue', DEFAULT_ACCOUNTS.salesRevenue),
      vatOutput: await mappedAccount('vatOutput', 'tax', 'vatOutput', DEFAULT_ACCOUNTS.vatOutput),
      costOfGoodsSold: await mappedAccount('costOfGoodsSold', 'inventory', 'costOfGoodsSold', DEFAULT_ACCOUNTS.costOfGoodsSold),
    };
    if (serviceChargeAmount > 0) {
      const serviceChargeAccount = serviceCharge.mode === 'income'
        ? 'serviceChargeIncome'
        : serviceCharge.mode === 'pass-through'
          ? 'serviceChargePayable'
          : null;
      if (!serviceChargeAccount) {
        throw Object.assign(new TypeError('Restaurant service-charge mode is invalid for accounting.'), {
          code: 'RESTAURANT_SERVICE_CHARGE_ACCOUNTING_INVALID',
        });
      }
      Object.assign(
        accounts,
        posAccountingProfileService.assertAccountMappings(accountingProfile, [serviceChargeAccount], scope),
      );
    }
  } catch (error) {
    error.accountingPostingFailure = true;
    throw error;
  }
  const postingInvoice = {
    id: String(invoice._id || invoice.id),
    referenceNo: invoice.referenceNo,
    posCheckoutPayload: invoice.posCheckoutPayload,
    ebm: { ...(invoice.ebm || {}), ...(paymentFlow === 'PAYMENTS_V2' ? { paymentFlow } : {}) },
    totalAmount,
    subtotal,
    totalDiscount,
    taxAmount,
    amountPaid,
    amountOutstanding,
    lines,
    cogsAmount,
  };
  const postingTenders = tenders.map((tender) => ({
    ...tender,
    amountRwf: tender.amount,
    accountCode: tender.bankAccountId
      && (tender.paymentMethod === 'bank_transfer'
        || (tender.paymentMethod === 'mobile_money' && !tender.provider))
      ? paymentAccounts.get(String(tender.bankAccountId))?.ledgerAccountId
      : undefined,
  }));
  let builtEntries;
  try {
    await posAccountingProfileService.assertTenderMappings(
      accountingProfile,
      postingTenders,
      { ...scope, companyId: String(companyId) },
      { requireAccountsReceivable: amountOutstanding > 0 },
    );
    builtEntries = buildSaleJournalEntries({
      invoice: postingInvoice,
      tenders: postingTenders,
      accounts,
    });
  } catch (error) {
    error.accountingPostingFailure = true;
    throw error;
  }

  const revenueLines = builtEntries[0].lines.map((line) => (
    line.debit > 0
      ? JournalService.createDebitLine(line.accountCode, line.debit, line.description)
      : JournalService.createCreditLine(line.accountCode, line.credit, line.description)
  ));
  if (loyaltyEarned > 0) {
    revenueLines.push(
      JournalService.createDebitLine(
        accounts.loyaltyRewardsExpense,
        loyaltyEarned,
        `Loyalty credit earned - Invoice ${invoice.referenceNo}`,
      ),
      JournalService.createCreditLine(
        accounts.customerAdvances,
        loyaltyEarned,
        `Loyalty credit liability - Invoice ${invoice.referenceNo}`,
      ),
    );
  }
  if (revenueLines.length < 2) {
    const error = new Error('The sale cannot be posted because it has no positive amount to account for');
    error.code = 'POS_ZERO_VALUE_SALE';
    throw error;
  }

  const journalEntries = builtEntries.map((entry, index) => ({
    date: invoice.invoiceDate,
    description: index === 0
      ? `Direct sale - Invoice ${invoice.referenceNo}`
      : `COGS for Invoice ${invoice.referenceNo}`,
    sourceType: entry.sourceType,
    sourceId: invoice._id || invoice.id,
    sourceReference: invoice.referenceNo,
    lines: index === 0
      ? revenueLines
      : entry.lines.map((line) => (
        line.debit > 0
          ? JournalService.createDebitLine(line.accountCode, line.debit, line.description)
          : JournalService.createCreditLine(line.accountCode, line.credit, line.description)
      )),
    isAutoGenerated: true,
    ...(index === 0 ? { sourceData: {
      payments: tenders.map((tender) => ({
        amount: tender.amount,
        paymentMethod: tender.paymentMethod,
        reference: tender.reference || null,
        providerName: tender.providerName || null,
        bankAccountId: tender.bankAccountId || null,
        storedValueAccountId: tender.storedValueAccountId || null,
        loyaltyPointsRedeemed: tender.loyaltyPointsRedeemed || null,
        loyaltyPointValueRwf: tender.loyaltyPointValueRwf || null,
      })),
      loyaltyCreditEarned: loyaltyEarned,
      ...(paymentFlow === 'PAYMENTS_V2' ? { paymentFlow } : {}),
    } } : {}),
  }));

  return {
    journalEntries,
    accounts,
    salesAccount: accounts.salesRevenue,
    taxAccount: accounts.vatOutput,
  };
}

module.exports = { buildPosSaleJournalEntries };
