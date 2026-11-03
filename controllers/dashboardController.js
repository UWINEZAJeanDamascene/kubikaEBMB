const Product = require('../models/Product');
const Invoice = require('../models/Invoice');
const Quotation = require('../models/Quotation');
const StockMovement = require('../models/StockMovement');
const Client = require('../models/Client');
const ActionLog = require('../models/ActionLog');
const CreditNote = require('../models/CreditNote');
const InventoryDashboardService = require('../services/dashboards/InventoryDashboardService');
const PeriodComparisonService = require('../services/dashboards/PeriodComparisonService');
const RatiosWidgetService = require('../services/dashboards/RatiosWidgetService');
const FinanceDashboardService = require('../services/dashboards/FinanceDashboardService');
const PurchaseDashboardService = require('../services/dashboards/PurchaseDashboardService');
const SalesDashboardService = require('../services/dashboards/SalesDashboardService');
const ExecutiveDashboardService = require('../services/dashboards/ExecutiveDashboardService');
const { parsePagination, paginationMeta, MAX_LIMIT } = require('../utils/pagination');
const { dbClient } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const { decimalToNumber } = require('../utils/decimalHelpers');

// @desc    Get dashboard statistics
// @route   GET /api/dashboard/stats
// @access  Private
exports.getDashboardStats = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const companyKey = toIdString(companyId);
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    // Product stats
    const totalProducts = await dbClient().product.count({ where: { companyId: companyKey, isArchived: false } });

    const [lowStockProducts, outOfStockProducts, stockValAgg] = await Promise.all([
      dbClient().$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM products
        WHERE company_id = ${companyKey}
          AND is_archived = false
          AND current_stock > 0
          AND current_stock <= low_stock_threshold
      `,
      dbClient().product.count({ where: { companyId: companyKey, isArchived: false, currentStock: 0 } }),
      dbClient().$queryRaw`
        SELECT COALESCE(SUM(current_stock * average_cost), 0)::float AS "totalValue"
        FROM products
        WHERE company_id = ${companyKey} AND is_archived = false
      `,
    ]);

    const totalStockValue = Number(stockValAgg[0]?.totalValue || 0);
    const lowStockCount = Number(lowStockProducts[0]?.count || 0);

    // Previous month product stats for comparison
    const startOfLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const endOfLastMonth = new Date(today.getFullYear(), today.getMonth(), 0);
    const totalProductsLastMonth = await dbClient().product.count({
      where: { companyId: companyKey, isArchived: false, createdAt: { lte: endOfLastMonth } },
    });

    // Previous month client stats
    const totalClientsLastMonth = await dbClient().client.count({
      where: { companyId: companyKey, isActive: true, createdAt: { lte: endOfLastMonth } },
    });

    // Invoice stats
    const totalInvoices = await dbClient().invoice.count({ where: { companyId: companyKey } });
    const pendingInvoices = await dbClient().invoice.count({
      where: { companyId: companyKey, status: { in: ['pending', 'partial', 'overdue'] } },
    });
    
    const monthlyInvoices = await dbClient().invoice.aggregate({
      where: { companyId: companyKey, invoiceDate: { gte: startOfMonth } },
      _sum: { totalAmount: true, amountPaid: true },
      _count: { _all: true },
    });

    // Subtract credit notes issued this month from sales totals to reflect net sales
    const monthlyCreditNotes = await dbClient().creditNote.aggregate({
      where: { companyId: companyKey, creditDate: { gte: startOfMonth }, status: { not: 'draft' } },
      _sum: { totalAmount: true },
    });

    const yearlyInvoices = await dbClient().invoice.aggregate({
      where: { companyId: companyKey, invoiceDate: { gte: startOfYear } },
      _sum: { totalAmount: true, amountPaid: true },
      _count: { _all: true },
    });

    // Subtract credit notes for the year
    const yearlyCreditNotes = await dbClient().creditNote.aggregate({
      where: { companyId: companyKey, creditDate: { gte: startOfYear }, status: { not: 'draft' } },
      _sum: { totalAmount: true },
    });

    // Quotation stats
    const activeQuotations = await dbClient().quotation.count({
      where: { companyId: companyKey, status: { in: ['draft', 'sent', 'approved'] } },
    });

    // Client stats
    const totalClients = await dbClient().client.count({ where: { companyId: companyKey, isActive: true } });

    res.json({
      success: true,
      data: {
        products: {
          total: totalProducts,
          totalLastMonth: totalProductsLastMonth,
          lowStock: lowStockCount,
          outOfStock: outOfStockProducts,
          totalValue: totalStockValue
        },
        invoices: {
          total: totalInvoices,
          pending: pendingInvoices,
          monthly: {
            count: monthlyInvoices._count._all || 0,
            // subtract credit notes to show net sales
            total: decimalToNumber(monthlyInvoices._sum.totalAmount) - decimalToNumber(monthlyCreditNotes._sum.totalAmount),
            paid: decimalToNumber(monthlyInvoices._sum.amountPaid)
          },
          yearly: {
            count: yearlyInvoices._count._all || 0,
            total: decimalToNumber(yearlyInvoices._sum.totalAmount) - decimalToNumber(yearlyCreditNotes._sum.totalAmount),
            paid: decimalToNumber(yearlyInvoices._sum.amountPaid)
          }
        },
        quotations: {
          active: activeQuotations
        },
        clients: {
          total: totalClients,
          totalLastMonth: totalClientsLastMonth
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get recent activities
// @route   GET /api/dashboard/recent-activities
// @access  Private
exports.getRecentActivities = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const limit = parseInt(req.query.limit) || 20;

    const activities = await ActionLog.find({ company: companyId })
      .populate('user', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      success: true,
      count: activities.length,
      data: activities
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get low stock alerts
// @route   GET /api/dashboard/low-stock-alerts
// @access  Private
exports.getLowStockAlerts = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    
    const products = await Product.find({
      company: companyId,
      isArchived: false,
      $expr: { $lte: ['$currentStock', '$lowStockThreshold'] }
    })
      .populate('category', 'name')
      .sort({ currentStock: 1 })
      .limit(20);

    res.json({
      success: true,
      count: products.length,
      data: products
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get top selling products
// @route   GET /api/dashboard/top-selling-products
// @access  Private
exports.getTopSellingProducts = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const limit = parseInt(req.query.limit) || 10;
    const { startDate, endDate } = req.query;

    const matchStage = {
      company: companyId,
      type: 'out',
      reason: 'sale'
    };

    if (startDate || endDate) {
      matchStage.movementDate = {};
      if (startDate) matchStage.movementDate.$gte = new Date(startDate);
      if (endDate) matchStage.movementDate.$lte = new Date(endDate);
    }

    const topProducts = await dbClient().stockMovement.groupBy({
      by: ['productId'],
      where: {
        companyId: toIdString(companyId), type: 'out', reason: 'sale',
        ...(startDate || endDate ? { movementDate: {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate ? { lte: new Date(endDate) } : {}),
        } } : {}),
      },
      _sum: { quantity: true, totalCost: true },
      _count: { _all: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });
    const productIds = topProducts.map((row) => row.productId).filter(Boolean);
    const products = await dbClient().product.findMany({
      where: { companyId: toIdString(companyId), id: { in: productIds } },
      select: { id: true, name: true, sku: true, unit: true, category: { select: { name: true } } },
    });
    const productById = new Map(products.map((product) => [product.id, product]));
    const topProductRows = topProducts.map((row) => ({
      _id: productById.get(row.productId) || row.productId,
      totalQuantity: decimalToNumber(row._sum.quantity),
      totalRevenue: decimalToNumber(row._sum.totalCost),
      salesCount: row._count._all,
    }));

    res.json({
      success: true,
      count: topProductRows.length,
      data: topProductRows
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get top clients
// @route   GET /api/dashboard/top-clients
// @access  Private
exports.getTopClients = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const limit = parseInt(req.query.limit) || 10;
    const { startDate, endDate } = req.query;

    const matchStage = {
      company: companyId,
      status: { $in: ['paid', 'partial'] }
    };

    if (startDate || endDate) {
      matchStage.invoiceDate = {};
      if (startDate) matchStage.invoiceDate.$gte = new Date(startDate);
      if (endDate) matchStage.invoiceDate.$lte = new Date(endDate);
    }

    const topClients = await dbClient().invoice.groupBy({
      by: ['clientId'],
      where: {
        companyId: toIdString(companyId), status: { in: ['paid', 'partial'] },
        ...(startDate || endDate ? { invoiceDate: {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate ? { lte: new Date(endDate) } : {}),
        } } : {}),
      },
      _sum: { totalAmount: true, amountPaid: true },
      _count: { _all: true },
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: limit,
    });
    const clientIds = topClients.map((row) => row.clientId);
    const clients = await dbClient().client.findMany({
      where: { companyId: toIdString(companyId), id: { in: clientIds } },
      select: { id: true, name: true, code: true, contact: true, type: true },
    });
    const clientById = new Map(clients.map((client) => [client.id, client]));
    const topClientRows = topClients.map((row) => ({
      _id: clientById.get(row.clientId) || row.clientId,
      totalAmount: decimalToNumber(row._sum.totalAmount),
      totalPaid: decimalToNumber(row._sum.amountPaid),
      invoiceCount: row._count._all,
    }));

    res.json({
      success: true,
      count: topClientRows.length,
      data: topClientRows
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get sales chart data
// @route   GET /api/dashboard/sales-chart
// @access  Private
exports.getSalesChart = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const { period = 'month' } = req.query; // 'week', 'month', 'year'
    
    let startDate = new Date();

    if (period === 'week') {
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === 'month') {
      startDate.setMonth(startDate.getMonth() - 1);
    } else {
      startDate.setFullYear(startDate.getFullYear() - 1);
    }

    const bucket = period === 'year' ? 'month' : 'day';
    const salesData = await dbClient().$queryRaw`
      SELECT TO_CHAR(DATE_TRUNC(${bucket}, invoice_date), ${period === 'year' ? 'YYYY-MM' : 'YYYY-MM-DD'}) AS month,
             COALESCE(SUM(total_amount), 0)::float AS sales
      FROM invoices
      WHERE company_id = ${toIdString(companyId)}
        AND invoice_date >= ${startDate}
        AND status <> 'cancelled'
        AND status <> 'PENDING_PAYMENT'
      GROUP BY DATE_TRUNC(${bucket}, invoice_date)
      ORDER BY DATE_TRUNC(${bucket}, invoice_date)
    `;

    // Transform data for frontend chart
    const formattedSalesData = salesData.map(item => ({
      month: item.month,
      sales: item.sales
    }));

    res.json({
      success: true,
      data: formattedSalesData
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get stock movement chart data
// @route   GET /api/dashboard/stock-movement-chart
// @access  Private
exports.getStockMovementChart = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const { period = 'month' } = req.query;
    
    let startDate = new Date();

    if (period === 'week') {
      startDate.setDate(startDate.getDate() - 7);
    } else if (period === 'month') {
      startDate.setMonth(startDate.getMonth() - 1);
    } else {
      startDate.setFullYear(startDate.getFullYear() - 1);
    }

    const movementData = await dbClient().stockMovement.groupBy({
      by: ['type'],
      where: { companyId: toIdString(companyId), movementDate: { gte: startDate } },
      _sum: { quantity: true },
    });

    // Transform data for frontend chart
    const formattedStockData = movementData.map(item => ({
      type: item.type || 'unknown',
      quantity: decimalToNumber(item._sum.quantity)
    }));

    res.json({
      success: true,
      data: formattedStockData
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get inventory dashboard data
// @route   GET /api/dashboard/inventory
// @access  Private
exports.getInventoryDashboard = async (req, res, next) => {
  try {
    // Check if user is platform admin
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const inventoryData = await InventoryDashboardService.get(companyId);
    
    res.json({
      success: true,
      data: inventoryData
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Period comparison (this month vs last month vs same month last year)
// @route   GET /api/dashboard/period-comparison
// @access  Private
exports.getPeriodComparison = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const data = await PeriodComparisonService.get(companyId.toString());

    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Executive dashboard (revenue, expenses, profit, cash, AR, recent journals)
// @route   GET /api/dashboard/executive
// @access  Private
exports.getExecutiveDashboard = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const data = await ExecutiveDashboardService.get(companyId.toString());

    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Finance dashboard (banks, AP due, budget vs actual, tax, cash flow)
// @route   GET /api/dashboard/finance
// @access  Private
exports.getFinanceDashboard = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const data = await FinanceDashboardService.get(companyId.toString());

    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Sales dashboard (invoices, AR, clients, credit notes)
// @route   GET /api/dashboard/sales
// @access  Private
exports.getSalesDashboard = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const data = await SalesDashboardService.get(companyId.toString());

    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Purchase dashboard (POs, GRN, AP, suppliers)
// @route   GET /api/dashboard/purchase
// @access  Private
exports.getPurchaseDashboard = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const data = await PurchaseDashboardService.get(companyId.toString());

    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Financial ratios widget (9 ratios + status styling)
// @route   GET /api/dashboard/ratios
// @access  Private
exports.getRatiosWidget = async (req, res, next) => {
  try {
    if (req.isPlatformAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Platform admin should use platform-specific endpoints'
      });
    }

    const companyId = req.user.company._id;
    const data = await RatiosWidgetService.get(companyId.toString());

    res.json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};
