const { authenticateAgent } = require('../services/posPrintAgentService');

exports.requirePrintAgent = async (req, res, next) => {
  try {
    const agent = await authenticateAgent(req);
    if (!agent) {
      return res.status(401).json({
        success: false,
        code: 'PRINT_AGENT_UNAUTHORIZED',
        message: 'Print agent access token is missing, invalid, expired, or revoked.',
      });
    }
    req.printAgent = agent;
    next();
  } catch (error) {
    next(error);
  }
};
