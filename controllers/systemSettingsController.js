const SystemSettingsService = require('../services/systemSettingsService')

/**
 * Get system settings for the authenticated user's company
 * GET /api/settings
 */
exports.getSettings = async (req, res) => {
  try {
    const companyId = req.companyId

    const settings = await SystemSettingsService.get(companyId)

    return res.status(200).json({
      success: true,
      data: settings
    })
  } catch (error) {
    console.error('Error fetching system settings:', error)
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch system settings',
      error: error.message
    })
  }
}

/**
 * Update system settings for the authenticated user's company
 * PUT /api/settings
 */
exports.updateSettings = async (req, res) => {
  try {
    const companyId = req.companyId
    const userId = req.user._id
    const data = req.body

    // Validate allowed fields
    const allowedFields = [
      'invoice_prefix',
      'invoice_footer_text',
      'invoice_payment_instructions',
      'default_invoice_due_days',
      'default_quote_expiry_days',
      'auto_apply_vat',
      'default_vat_rate_id',
      'default_costing_method',
      'allow_negative_stock',
      'low_stock_alert_enabled',
      'require_po_approval',
      'po_approval_threshold',
      'require_invoice_approval',
      'document_terms_and_conditions',
      'document_theme_color',
      'notify_on_low_stock',
      'notify_on_overdue_invoice',
      'overdue_invoice_alert_days',
      'pos_offline_enabled',
      'pos_offline_max_hours',
      'pos_offline_queue_limit',
      'pos_offline_max_sales',
      'pos_offline_max_single_sale',
      'pos_negative_stock_escalation_days'
    ]

    // Filter to only allowed fields
    const filteredData = {}
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        filteredData[field] = data[field]
      }
    }

    // Validate costing_method if provided
    if (filteredData.default_costing_method && !['fifo', 'wac'].includes(filteredData.default_costing_method)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid default_costing_method. Must be "fifo" or "wac"'
      })
    }

    // Validate numeric fields
    if (filteredData.default_invoice_due_days !== undefined) {
      if (typeof filteredData.default_invoice_due_days !== 'number' || filteredData.default_invoice_due_days < 0) {
        return res.status(400).json({
          success: false,
          message: 'default_invoice_due_days must be a positive number'
        })
      }
    }

    if (filteredData.default_quote_expiry_days !== undefined) {
      if (typeof filteredData.default_quote_expiry_days !== 'number' || filteredData.default_quote_expiry_days < 0) {
        return res.status(400).json({
          success: false,
          message: 'default_quote_expiry_days must be a positive number'
        })
      }
    }

    if (filteredData.po_approval_threshold !== undefined) {
      if (typeof filteredData.po_approval_threshold !== 'number' || filteredData.po_approval_threshold < 0) {
        return res.status(400).json({
          success: false,
          message: 'po_approval_threshold must be a positive number'
        })
      }
    }

    if (filteredData.overdue_invoice_alert_days !== undefined) {
      if (typeof filteredData.overdue_invoice_alert_days !== 'number' || filteredData.overdue_invoice_alert_days < 0) {
        return res.status(400).json({
          success: false,
          message: 'overdue_invoice_alert_days must be a positive number'
        })
      }
    }

    if (filteredData.pos_offline_enabled !== undefined && typeof filteredData.pos_offline_enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'pos_offline_enabled must be a boolean' })
    }
    if (filteredData.pos_offline_max_hours !== undefined
      && (!Number.isInteger(filteredData.pos_offline_max_hours) || filteredData.pos_offline_max_hours < 1 || filteredData.pos_offline_max_hours > 720)) {
      return res.status(400).json({ success: false, message: 'pos_offline_max_hours must be an integer from 1 to 720' })
    }
    if (filteredData.pos_offline_queue_limit !== undefined
      && (!Number.isSafeInteger(filteredData.pos_offline_queue_limit) || filteredData.pos_offline_queue_limit < 1 || filteredData.pos_offline_queue_limit > 1000000000)) {
      return res.status(400).json({ success: false, message: 'pos_offline_queue_limit must be a whole RWF amount from 1 to 1,000,000,000' })
    }
    if (filteredData.pos_offline_max_sales !== undefined
      && (!Number.isInteger(filteredData.pos_offline_max_sales) || filteredData.pos_offline_max_sales < 1 || filteredData.pos_offline_max_sales > 1000000)) {
      return res.status(400).json({ success: false, message: 'pos_offline_max_sales must be a whole number from 1 to 1,000,000' })
    }
    if (filteredData.pos_offline_max_single_sale !== undefined
      && (!Number.isSafeInteger(filteredData.pos_offline_max_single_sale) || filteredData.pos_offline_max_single_sale < 1 || filteredData.pos_offline_max_single_sale > 1000000000)) {
      return res.status(400).json({ success: false, message: 'pos_offline_max_single_sale must be a whole RWF amount from 1 to 1,000,000,000' })
    }
    if (filteredData.pos_offline_queue_limit !== undefined || filteredData.pos_offline_max_single_sale !== undefined) {
      const current = await SystemSettingsService.get(companyId)
      const totalLimit = filteredData.pos_offline_queue_limit ?? Number(current.pos_offline_queue_limit)
      const singleSaleLimit = filteredData.pos_offline_max_single_sale ?? Number(current.pos_offline_max_single_sale)
      if (singleSaleLimit > totalLimit) {
        return res.status(400).json({ success: false, message: 'The maximum single offline sale cannot exceed the total offline value limit.' })
      }
    }
    if (filteredData.pos_negative_stock_escalation_days !== undefined
      && (!Number.isInteger(filteredData.pos_negative_stock_escalation_days) || filteredData.pos_negative_stock_escalation_days < 1 || filteredData.pos_negative_stock_escalation_days > 365)) {
      return res.status(400).json({ success: false, message: 'pos_negative_stock_escalation_days must be an integer from 1 to 365' })
    }

    // Validate theme color if provided
    if (filteredData.document_theme_color !== undefined) {
      const colorRegex = /^#[0-9A-Fa-f]{6}$/
      if (!colorRegex.test(filteredData.document_theme_color)) {
        return res.status(400).json({
          success: false,
          message: 'document_theme_color must be a valid hex color (e.g., #1D9E75)'
        })
      }
    }

    const settings = await SystemSettingsService.update(companyId, filteredData, userId)

    return res.status(200).json({
      success: true,
      data: settings
    })
  } catch (error) {
    console.error('Error updating system settings:', error)
    return res.status(500).json({
      success: false,
      message: 'Failed to update system settings',
      error: error.message
    })
  }
}
