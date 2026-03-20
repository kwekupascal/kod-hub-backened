const { adminAuth } = require('./firebase');

async function requireFirebaseUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        message: 'Missing or invalid Authorization header'
      });
    }

    const token = authHeader.substring(7).trim();
    const decodedToken = await adminAuth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Auth verification failed:', error);
    return res.status(401).json({
      ok: false,
      message: 'Unauthorized'
    });
  }
}

module.exports = {
  requireFirebaseUser
};
