const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const JournalService = require('../services/journalService');
const posAccountingPostingService = require('../services/posAccountingPostingService');
const Client = require('../models/Client');
const { BankAccount } = require('../models/BankAccount');
const TillSession = require('../models/TillSession');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { generateObjectId } = require('../utils/objectId');
const CurrencyService = require('../services/CurrencyService');
const { findClaimedRegister } = require('../services/posRegisterService');
const {
  normalizeStoredValueCode,
  hashStoredValueCode,
  generateStoredValueCode,
} = require('../services/posStoredValueCodeService');

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

exports.lookup = async (req, res) => {
  try {
    const companyId = String(req.user.company._id);
    const clientId = String(req.query.clientId || '');
    const code = normalizeStoredValueCode(req.query.code);
    const kind = String(req.query.kind || '').toLowerCase();
    if (kind === 'loyalty') {
      if (!/^[a-f\d]{24}$/i.test(clientId)) return res.status(400).json({ success: false, message: 'Select a registered customer to check loyalty credit.' });
      const [wallets, pointRows, settings] = await Promise.all([
        dbClient().$queryRawUnsafe(
          `SELECT a.currency_code AS "currencyCode", COALESCE(SUM(a.balance), 0)::numeric AS balance
             FROM pos_stored_value_accounts a
             JOIN clients c ON c.id = a.client_id AND c.company_id = a.company_id
            WHERE a.company_id = $1 AND (c.id = $2 OR c.merged_into_client_id = $2) AND a.kind = 'loyalty' AND a.is_active = TRUE
            GROUP BY a.currency_code ORDER BY a.currency_code`,
          companyId, clientId,
        ),
        dbClient().$queryRawUnsafe(
          `SELECT COALESCE(SUM(l.points), 0)::int AS balance
             FROM pos_customer_loyalty_ledger l
             JOIN clients c ON c.id = l.client_id AND c.company_id = l.company_id
            WHERE l.company_id = $1 AND (c.id = $2 OR c.merged_into_client_id = $2)`,
          companyId, clientId,
        ),
        dbClient().systemSettings.findUnique({ where: { companyId }, select: { posLoyaltySettings: true } }),
      ]);
      const currencyCode = await CurrencyService.getCompanyBase(companyId);
      const selectedWallet = wallets.find((row) => String(row.currencyCode).toUpperCase() === String(currencyCode).toUpperCase());
      const pointValueRwf = Number(settings?.posLoyaltySettings?.pointValueRwf ?? 1);
      return res.json({ success: true, data: {
        kind, balance: Number(selectedWallet?.balance || 0), currencyCode,
        wallets: wallets.map((row) => ({ currencyCode: row.currencyCode, balance: Number(row.balance || 0) })),
        pointBalance: Number(pointRows[0]?.balance || 0), pointValueRwf,
      } });
    }
    if (!['gift_card', 'store_credit'].includes(kind) || code.length < 8 || code.length > 80) {
      return res.status(400).json({ success: false, message: 'Enter a valid gift card or store credit code.' });
    }
    const rows = await dbClient().$queryRawUnsafe(
      'SELECT id, kind, balance, currency_code AS "currencyCode", code_suffix AS "codeSuffix", client_id AS "clientId", expires_at AS "expiresAt" FROM pos_stored_value_accounts WHERE company_id = $1 AND code_hash = $2 AND kind = $3 AND is_active = TRUE LIMIT 1',
      companyId, hashStoredValueCode(code), kind,
    );
    const account = rows[0];
    if (!account || account.expiresAt && new Date(account.expiresAt) <= new Date()) return res.status(404).json({ success: false, message: 'Stored value account was not found or has expired.' });
    if (account.clientId && account.clientId !== clientId) return res.status(403).json({ success: false, message: 'This store credit belongs to another customer.' });
    return res.json({ success: true, data: { kind, balance: Number(account.balance), currencyCode: account.currencyCode, codeSuffix: account.codeSuffix } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not look up stored value.' });
  }
};

exports.issue = async (req, res) => {
  try {
    const companyId = String(req.user.company._id);
    const kind = String(req.body.kind || '').toLowerCase();
    const amount = roundMoney(req.body.amount);
    const notes = String(req.body.reason || '').trim();
    const clientId = req.body.clientId ? String(req.body.clientId) : null;
    if (!['gift_card', 'store_credit'].includes(kind) || !Number.isFinite(amount) || amount <= 0 || !notes || notes.length > 500) {
      return res.status(400).json({ success: false, message: 'Choose gift card or store credit and provide a positive amount and reason.' });
    }
    if (kind === 'store_credit' && (!clientId || !/^[a-f\d]{24}$/i.test(clientId))) return res.status(400).json({ success: false, message: 'Store credit must be assigned to a customer.' });
    const currencyCode = await CurrencyService.getCompanyBase(companyId);
    const client = clientId ? await Client.findOne({ _id: clientId, company: companyId, isActive: true }) : null;
    if (clientId && !client) return res.status(404).json({ success: false, message: 'Customer was not found.' });

    let code = '';
    const accountId = generateObjectId();
    const entryId = generateObjectId();
    const actorId = String(req.user.id);
    let fundingMethod = String(req.body.paymentMethod || '').toLowerCase();
    let bankAccount = null;
    let till = null;
    let debitCode;
    let creditCode;
    let postingStatus = 'pending';
    if (kind === 'gift_card') {
      if (!['cash', 'bank_transfer', 'mobile_money'].includes(fundingMethod)) return res.status(400).json({ success: false, message: 'Gift cards must be funded by cash or a recorded bank/mobile-money payment.' });
      if (fundingMethod !== 'cash') {
        const reference = String(req.body.reference || '').trim();
        if (!reference || reference.length > 120) return res.status(400).json({ success: false, message: 'Enter the verified payment reference.' });
        if (!req.body.bankAccountId) return res.status(400).json({ success: false, message: 'Select the settlement account.' });
        bankAccount = await BankAccount.findOne({ _id: req.body.bankAccountId, company: companyId, isActive: true }).select('_id ledgerAccountId').lean();
        if (!bankAccount?.ledgerAccountId) return res.status(400).json({ success: false, message: 'The selected settlement account is unavailable.' });
        debitCode = bankAccount.ledgerAccountId;
      } else {
        const claimedRegister = await findClaimedRegister(companyId, req.body.registerId, req.body.deviceId);
        if (!claimedRegister) return res.status(409).json({ success: false, message: 'Claim a managed POS register on this device before issuing a cash-funded gift card.' });
        till = await TillSession.findOne({ company: companyId, openedBy: actorId, registerId: claimedRegister.code, status: 'open' }).sort({ openedAt: -1 });
        if (till && req.body.tillSessionId && String(till._id) !== String(req.body.tillSessionId)) till = null;
        if (!till) return res.status(409).json({ success: false, message: 'Open your assigned till before taking cash for a gift card.' });
        debitCode = await JournalService.getMappedAccountCode(companyId, 'cash', 'cashOnHand', DEFAULT_ACCOUNTS.cashOnHand || '1000');
      }
      creditCode = await JournalService.getMappedAccountCode(companyId, 'cash', 'deferredRevenue', DEFAULT_ACCOUNTS.deferredRevenue || '2850');
    } else {
      fundingMethod = 'store_credit_grant';
      debitCode = DEFAULT_ACCOUNTS.salesReturns || '4100';
      creditCode = DEFAULT_ACCOUNTS.customerAdvances || '2860';
    }

    await runInTransaction(async (session) => {
      let accountCreated = false;
      for (let attempt = 0; attempt < 8 && !accountCreated; attempt += 1) {
        code = generateStoredValueCode();
        const inserted = await dbClient().$executeRawUnsafe(
          'INSERT INTO pos_stored_value_accounts (id, company_id, client_id, kind, code_hash, code_suffix, currency_code, balance, is_active, created_by_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (company_id, code_hash) DO NOTHING',
          accountId, companyId, clientId, kind, hashStoredValueCode(code), code.slice(-4), currencyCode, amount, actorId,
        );
        accountCreated = Number(inserted) === 1;
      }
      if (!accountCreated) throw new Error('Could not generate a unique stored-value code.');
      await dbClient().$executeRawUnsafe(
        'INSERT INTO pos_stored_value_ledger (id, company_id, account_id, kind, entry_type, amount, balance_after, reference, notes, created_by_id, created_at) VALUES ($1, $2, $3, $4, \'issue\', $5, $5, $6, $7, $8, CURRENT_TIMESTAMP)',
        entryId, companyId, accountId, kind, amount, String(req.body.reference || '').trim() || null, notes, actorId,
      );
      const lines = [
        JournalService.createDebitLine(debitCode, amount, `${kind === 'gift_card' ? 'Gift card' : 'Customer store credit'} issued`),
        JournalService.createCreditLine(creditCode, amount, `${kind === 'gift_card' ? 'Gift card' : 'Customer store credit'} liability`),
      ];
      const posting = await posAccountingPostingService.postOrQueue({
        tx: session,
        companyId,
        userId: actorId,
        sourceType: 'pos_stored_value_issue',
        sourceId: accountId,
        metadata: { relatedLedgerEntryId: entryId },
        entries: [{
          date: new Date(),
          description: `${kind === 'gift_card' ? 'Gift card' : 'Store credit'} issued`,
          sourceType: 'pos_stored_value_issue',
          sourceId: accountId,
          sourceReference: accountId,
          lines,
          isAutoGenerated: true,
          notes,
          sourceData: { paymentMethod: fundingMethod, bankAccountId: bankAccount?._id || null },
        }],
      });
      postingStatus = posting.status;
      await dbClient().$executeRawUnsafe(
        'UPDATE pos_stored_value_ledger SET journal_entry_id = COALESCE($1, journal_entry_id), posting_status = $2 WHERE id = $3 AND company_id = $4',
        posting.journalEntryIds[0] || null,
        postingStatus,
        entryId,
        companyId,
      );
      if (kind === 'gift_card' && fundingMethod === 'cash' && till) {
        const activity = { type: 'gift_card_issue', amount, reference: code.slice(-4), recordedBy: actorId, recordedAt: new Date().toISOString() };
        const result = await dbClient().$queryRawUnsafe(
          'UPDATE till_sessions SET expected_cash = expected_cash + $1::numeric, cash_activity = COALESCE(cash_activity, \'[]\'::jsonb) || $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND company_id = $4 AND status = \'open\' RETURNING id',
          amount, JSON.stringify([activity]), String(till._id), companyId,
        );
        if (!result.length) throw new Error('Till was closed while the gift card was being issued.');
      }
    });

    return res.status(201).json({ success: true, message: 'Stored value issued.', data: { kind, code, amount, currencyCode, customerName: client?.name || null, postingStatus } });
  } catch (error) {
    console.error('[POS stored value issue]', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Could not issue stored value.' });
  }
};

exports.getCustomerLoyalty = async (req, res) => {
  req.query.kind = 'loyalty';
  return exports.lookup(req, res);
};
