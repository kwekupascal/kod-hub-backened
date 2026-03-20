const admin = require('firebase-admin');
const path = require('path');

function initializeFirebase() {
  if (admin.apps.length > 0) return admin.app();

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
  const resolvedPath = path.resolve(serviceAccountPath);

  const serviceAccount = require(resolvedPath);

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

function db() {
  return admin.firestore();
}

function adminAuth() {
  return admin.auth();
}

module.exports = {
  initializeFirebase,
  db,
  adminAuth,
  admin
};
