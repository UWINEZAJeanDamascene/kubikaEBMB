const { prisma } = require('../lib/prisma');

async function requirePlatformAdmin(req, res, next) {
  if (req.user?.role !== 'platform_admin') {
    return res.status(403).json({
      success: false,
      code: 'PLATFORM_ADMIN_REQUIRED',
      message: 'Only a platform administrator can access this control.',
    });
  }

  try {
    const userId = String(req.user.id || req.user._id || '');
    const user = userId
      ? await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      })
      : null;

    if (user?.role !== 'platform_admin') {
      return res.status(403).json({
        success: false,
        code: 'PLATFORM_ADMIN_REQUIRED',
        message: 'Only a platform administrator can access this control.',
      });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = requirePlatformAdmin;
