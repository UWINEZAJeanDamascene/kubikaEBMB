'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const controller = require('../controllers/posPublicReceiptController');

const router = express.Router();
const publicReceiptLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'POS_PUBLIC_RECEIPT_RATE_LIMITED', message: 'Too many receipt requests. Try again later.' },
});

router.use(publicReceiptLimit);
router.get('/:token/pdf', controller.publicPdf);
router.get('/:token', controller.publicDocument);

module.exports = router;
