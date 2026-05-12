export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.system_role)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  next();
};
