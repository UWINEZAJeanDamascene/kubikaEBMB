const { prisma } = require('../../lib/prisma')
const { toIdString } = require('../../utils/objectId')
const { decimalToNumber } = require('../../utils/decimalHelpers')
const dateHelpers = require('../../utils/dateHelpers')
const dashboardCache = require('../DashboardCacheService')

const TOP_CLIENTS_LIMIT = 5

/** Invoice statuses for AR aging (open balances) */
const AR_OPEN_STATUSES = ['confirmed', 'partially_paid']

/** Issued / billable invoices (exclude drafts from headline KPIs) */
const NON_DRAFT_STATUSES = ['confirmed', 'partially_paid', 'fully_paid', 'cancelled']

const INVOICE_STATUS_ORDER = [
  'draft',
  'confirmed',
  'partially_paid',
  'fully_paid',
  'cancelled'
]

const MARGIN_MS = 24 * 60 * 60 * 1000

class SalesDashboardService {
  static async get(companyId) {
    const cached = await dashboardCache.get(companyId, 'sales')
    if (cached) return cached

    const thisMonth = dateHelpers.currentMonth()

    const [
      invoicesSummary,
      arAgingBuckets,
      topClientsByRevenue,
      invoicesByStatus,
      creditNotesSummary,
      collectionRate
    ] = await Promise.all([
      SalesDashboardService._getInvoicesSummary(companyId, thisMonth),
      SalesDashboardService._getARAgingBuckets(companyId),
      SalesDashboardService._getTopClients(companyId, TOP_CLIENTS_LIMIT),
      SalesDashboardService._getInvoicesByStatus(companyId),
      SalesDashboardService._getCreditNotesSummary(companyId, thisMonth),
      SalesDashboardService._getCollectionRate(companyId, thisMonth)
    ])

    const result = {
      company_id: companyId,
      generated_at: new Date(),
      date_context: {
        current_month_start: thisMonth.start,
        current_month_end: thisMonth.end
      },
      summary: {
        invoices_raised_mtd: invoicesSummary.invoices_raised,
        total_invoiced_mtd: invoicesSummary.total_invoiced,
        total_outstanding_ar: arAgingBuckets.total_ar_outstanding,
        collection_rate_pct: collectionRate.collection_rate_pct,
        credit_notes_mtd: creditNotesSummary.count
      },
      invoices: invoicesSummary,
      ar_aging: arAgingBuckets,
      top_clients: topClientsByRevenue,
      by_status: invoicesByStatus.map,
      by_status_list: invoicesByStatus.list,
      credit_notes: creditNotesSummary,
      collection_rate: collectionRate
    }

    await dashboardCache.set(companyId, 'sales', result)
    return result
  }

  /**
   * MTD invoice KPIs — excludes **draft** from counts and amounts (not yet issued).
   * Pushed down to a single SQL aggregate (SUM/COUNT) instead of pulling every
   * matching invoice row over the network and reducing in JS.
   */
  static async _getInvoicesSummary(companyId, period) {
    const cid = toIdString(companyId)
    const qStart = new Date(period.start.getTime() - MARGIN_MS)
    const qEnd = new Date(period.end.getTime() + MARGIN_MS)

    const agg = await prisma.invoice.aggregate({
      where: {
        companyId: cid,
        invoiceDate: { gte: qStart, lte: qEnd },
        status: { notIn: ['draft', 'PENDING_PAYMENT'] }
      },
      _count: true,
      _sum: { totalAmount: true, amountPaid: true, amountOutstanding: true }
    })

    return {
      invoices_raised: agg._count || 0,
      total_invoiced: dateHelpers.round2(decimalToNumber(agg._sum.totalAmount)),
      total_collected: dateHelpers.round2(decimalToNumber(agg._sum.amountPaid)),
      total_outstanding: dateHelpers.round2(decimalToNumber(agg._sum.amountOutstanding))
    }
  }

  /**
   * AR aging buckets — one grouped SQL scan (CASE/SUM) instead of fetching every
   * open invoice and bucketing in application memory.
   */
  static async _getARAgingBuckets(companyId) {
    const cid = toIdString(companyId)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)

    const rows = await prisma.$queryRaw`
      SELECT
        COALESCE(SUM(CASE WHEN due_date >= ${today} THEN amount_outstanding ELSE 0 END), 0)::float AS "notDue",
        COALESCE(SUM(CASE WHEN due_date < ${today}
          AND FLOOR(EXTRACT(EPOCH FROM (${today} - due_date)) / 86400) BETWEEN 1 AND 30
          THEN amount_outstanding ELSE 0 END), 0)::float AS "days1To30",
        COALESCE(SUM(CASE WHEN due_date < ${today}
          AND FLOOR(EXTRACT(EPOCH FROM (${today} - due_date)) / 86400) BETWEEN 31 AND 60
          THEN amount_outstanding ELSE 0 END), 0)::float AS "days31To60",
        COALESCE(SUM(CASE WHEN due_date < ${today}
          AND FLOOR(EXTRACT(EPOCH FROM (${today} - due_date)) / 86400) BETWEEN 61 AND 90
          THEN amount_outstanding ELSE 0 END), 0)::float AS "days61To90",
        COALESCE(SUM(CASE WHEN due_date < ${today}
          AND FLOOR(EXTRACT(EPOCH FROM (${today} - due_date)) / 86400) > 90
          THEN amount_outstanding ELSE 0 END), 0)::float AS "days90Plus",
        COALESCE(SUM(CASE WHEN due_date < ${today} THEN amount_outstanding ELSE 0 END), 0)::float AS "totalOverdue",
        COALESCE(SUM(amount_outstanding), 0)::float AS "totalArOutstanding"
      FROM invoices
      WHERE company_id = ${cid}
        AND status = ANY(${AR_OPEN_STATUSES}::text[])
    `

    const b = rows[0] || {}
    return {
      not_due: dateHelpers.round2(b.notDue || 0),
      days_1_30: dateHelpers.round2(b.days1To30 || 0),
      days_31_60: dateHelpers.round2(b.days31To60 || 0),
      days_61_90: dateHelpers.round2(b.days61To90 || 0),
      days_90_plus: dateHelpers.round2(b.days90Plus || 0),
      total_overdue: dateHelpers.round2(b.totalOverdue || 0),
      total_ar_outstanding: dateHelpers.round2(b.totalArOutstanding || 0)
    }
  }

  /**
   * Top clients by revenue — SQL GROUP BY + ORDER BY + LIMIT (only `limit` rows
   * ever leave Postgres), then one small lookup for client names/codes.
   */
  static async _getTopClients(companyId, limit) {
    const cid = toIdString(companyId)

    const grouped = await prisma.invoice.groupBy({
      by: ['clientId'],
      where: {
        companyId: cid,
        status: { notIn: ['draft', 'cancelled', 'PENDING_PAYMENT'] }
      },
      _sum: { totalAmount: true, amountPaid: true },
      _count: true,
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: limit
    })

    if (grouped.length === 0) return []

    const clients = await prisma.client.findMany({
      where: { id: { in: grouped.map((g) => g.clientId) } },
      select: { id: true, name: true, code: true }
    })
    const clientById = new Map(clients.map((c) => [c.id, c]))

    return grouped.map((g) => {
      const client = clientById.get(g.clientId)
      const totalInvoiced = decimalToNumber(g._sum.totalAmount)
      const totalPaid = decimalToNumber(g._sum.amountPaid)
      return {
        client_id: g.clientId,
        client_name: client ? client.name : null,
        client_code: (client && client.code) || '',
        total_invoiced: dateHelpers.round2(totalInvoiced),
        total_paid: dateHelpers.round2(totalPaid),
        outstanding: dateHelpers.round2(totalInvoiced - totalPaid),
        invoice_count: g._count
      }
    })
  }

  static async _getInvoicesByStatus(companyId) {
    const cid = toIdString(companyId)

    const grouped = await prisma.invoice.groupBy({
      by: ['status'],
      where: { companyId: cid },
      _count: true,
      _sum: { totalAmount: true }
    })

    const map = {}
    for (const row of grouped) {
      map[row.status] = {
        count: row._count,
        total_amount: dateHelpers.round2(decimalToNumber(row._sum.totalAmount))
      }
    }

    const list = INVOICE_STATUS_ORDER.map((status) => ({
      status,
      count: map[status] ? map[status].count : 0,
      total_amount: map[status] ? map[status].total_amount : 0
    }))

    return { map, list }
  }

  static async _getCreditNotesSummary(companyId, period) {
    const cid = toIdString(companyId)
    const qStart = new Date(period.start.getTime() - MARGIN_MS)
    const qEnd = new Date(period.end.getTime() + MARGIN_MS)

    const agg = await prisma.creditNote.aggregate({
      where: {
        companyId: cid,
        creditDate: { gte: qStart, lte: qEnd },
        status: 'confirmed'
      },
      _count: true,
      _sum: { totalAmount: true }
    })

    return {
      count: agg._count || 0,
      total_value: dateHelpers.round2(decimalToNumber(agg._sum.totalAmount))
    }
  }

  static async _getCollectionRate(companyId, period) {
    const cid = toIdString(companyId)
    const qStart = new Date(period.start.getTime() - MARGIN_MS)
    const qEnd = new Date(period.end.getTime() + MARGIN_MS)

    const agg = await prisma.invoice.aggregate({
      where: {
        companyId: cid,
        invoiceDate: { gte: qStart, lte: qEnd },
        status: { notIn: ['draft', 'cancelled', 'PENDING_PAYMENT'] }
      },
      _sum: { totalAmount: true, amountPaid: true }
    })

    const billed = decimalToNumber(agg._sum.totalAmount)
    const paid = decimalToNumber(agg._sum.amountPaid)
    const rate = dateHelpers.round2(dateHelpers.safeDivide(paid, billed) * 100)

    return {
      total_billed: dateHelpers.round2(billed),
      total_collected: dateHelpers.round2(paid),
      collection_rate_pct: rate
    }
  }
}

module.exports = SalesDashboardService
