const { db, admin } = require('../lib/firebase');

async function ensureWallet(userInfo) {
  const walletRef = db().collection('wallets').doc(userInfo.userId);
  const walletSnap = await walletRef.get();

  if (!walletSnap.exists) {
    await walletRef.set({
      userId: userInfo.userId,
      email: userInfo.email || '',
      displayName: userInfo.displayName || '',
      balance: 0,
      currency: 'GHS',
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  return walletRef;
}

async function creditWalletIfNeeded({ paymentId }) {
  const paymentRef = db().collection('payments').doc(paymentId);

  return db().runTransaction(async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) {
      throw new Error('Payment not found');
    }

    const payment = paymentSnap.data();

    if (payment.walletCreditApplied === true) {
      return { alreadyApplied: true, payment };
    }

    if (payment.status !== 'SUCCESS') {
      throw new Error('Cannot credit wallet for non-success payment');
    }

    const walletRef = db().collection('wallets').doc(payment.userId);
    const walletSnap = await tx.get(walletRef);

    let currentBalance = 0;
    if (walletSnap.exists) {
      currentBalance = Number(walletSnap.data().balance || 0);
    } else {
      tx.set(walletRef, {
        userId: payment.userId,
        email: payment.customerEmail || '',
        displayName: payment.customerName || '',
        balance: 0,
        currency: 'GHS',
        isActive: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const nextBalance = currentBalance + Number(payment.amount || 0);

    tx.set(walletRef, {
      balance: nextBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const txRef = db().collection('wallet_transactions').doc();
    tx.set(txRef, {
      transactionId: txRef.id,
      walletId: payment.userId,
      userId: payment.userId,
      paymentId: payment.paymentId,
      type: 'CREDIT',
      source: 'HUBTEL_MOMO',
      amount: Number(payment.amount || 0),
      currency: 'GHS',
      status: 'SUCCESS',
      reference: payment.clientReference || '',
      trackingId: payment.trackingId || '',
      message: 'Wallet funded successfully via mobile money.',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.set(paymentRef, {
      walletCreditApplied: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return { alreadyApplied: false, nextBalance };
  });
}

module.exports = {
  ensureWallet,
  creditWalletIfNeeded
};
