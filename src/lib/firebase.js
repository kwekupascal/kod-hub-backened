const admin = require('firebase-admin');

function initializeFirebase() {
  if (admin.apps.length > 0) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Missing Firebase Admin environment variables. ' +
      'Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY'
    );
  }

  // Render stores multiline secrets with escaped \\n in many cases.
  privateKey = privateKey.replace(/\\n/g, '\n');

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
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