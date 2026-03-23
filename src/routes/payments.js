const express = require('express');
const crypto = require('crypto');
const { requireFirebaseUser } = require('../lib/auth');
const { db, admin } = require('../lib/firebase');
const { ensureWallet, creditWalletIfNeeded } = require('../services/wallets');
const {
  generateClientReference,
  initializePaystackWalletCharge,
  verifyPaystackPayment
} = require('../services/paystack');

const router = express.Router();

function generateTrackingId() {
  return Date.now().toString().slice(-7);
}

function generateOrderReference(prefixValue) {
  const now = Date.now().toString();
  const short = now.slice(-10);
  const prefix = String(prefixValue || 'ORD').toUpperCase().replace(/\s+/g, '');
  return `ORD-${prefix}-${short}`;
}

function roundMoney(value) {
  return Number(Number(value).toFixed(2));
}

function calculatePaystackCharge(amount) {
  return roundMoney(Number(amount) * 0.03);
}

function calculateTotalPayable(amount) {
  return roundMoney(Number(amount) + calculatePaystackCharge(amount));
}

function verifyWebhookSignature(req) {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  const signature = req.headers['x-paystack-signature'];

  if (!secret || !signature) return false;

  const hash = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return hash === signature;
}

async function createDataOrderIfNeeded({ paymentId }) {
  const paymentRef = db().collection('payments').doc(paymentId);

  await db().runTransaction(async (transaction) => {
    const paymentSnap = await transaction.get(paymentRef);
    if (!paymentSnap.exists) return;

    const payment = paymentSnap.data();
    if (payment.type !== 'DATA_PURCHASE') return;
    if (payment.orderCreated === true) return;

    const orderRef = db().collection('orders').doc();
    const trackingId = payment.trackingId || generateTrackingId();
    const reference = payment.orderReference || generateOrderReference(payment.network);

    transaction.set(orderRef, {
      orderId: orderRef.id,
      userId: payment.userId,
      customerEmail: payment.customerEmail || '',
      customerName: payment.customerName || '',
      type: 'DATA',
      network: payment.network || '',
      msisdn: payment.phoneNumber || '',
      status: 'Accepted',
      amount: payment.amount || 0,
      value: payment.bundleValue || payment.bundleLabel || '',
      gateway: 'MOBILE_MONEY',
      reference,
      trackingId,
      message:
        'Order accepted successfully. Correct GB selected and payment completed successfully.',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    transaction.update(paymentRef, {
      orderCreated: true,
      orderId: orderRef.id,
      orderReference: reference,
      trackingId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function createAfaOrderIfNeeded({ paymentId }) {
  const paymentRef = db().collection('payments').doc(paymentId);

  await db().runTransaction(async (transaction) => {
    const paymentSnap = await transaction.get(paymentRef);
    if (!paymentSnap.exists) return;

    const payment = paymentSnap.data();
    if (payment.type !== 'AFA_PURCHASE') return;
    if (payment.orderCreated === true) return;

    const orderRef = db().collection('orders').doc();
    const trackingId = payment.trackingId || generateTrackingId();
    const reference = payment.orderReference || generateOrderReference('AFA');

    transaction.set(orderRef, {
      orderId: orderRef.id,
      userId: payment.userId,
      customerEmail: payment.customerEmail || '',
      customerName: payment.customerName || payment.fullName || '',
      type: 'AFA',
      network: 'AFA',
      fullName: payment.fullName || '',
      msisdn: payment.phoneNumber || '',
      phone: payment.phoneNumber || '',
      ghaCardNumber: payment.ghaCardNumber || '',
      town: payment.town || '',
      status: 'Accepted',
      amount: payment.amount || 0,
      value: 'AFA',
      gateway: 'MOBILE_MONEY',
      reference,
      trackingId,
      message:
        'AFA registration request accepted successfully. Payment completed successfully.',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    transaction.update(paymentRef, {
      orderCreated: true,
      orderId: orderRef.id,
      orderReference: reference,
      trackingId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
}

async function processSuccessfulPayment({ paymentId }) {
  const paymentRef = db().collection('payments').doc(paymentId);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) return;

  const payment = paymentSnap.data();

  if (payment.type === 'WALLET_FUNDING' && payment.walletCreditApplied !== true) {
    await creditWalletIfNeeded({ paymentId });
  }

  if (payment.type === 'DATA_PURCHASE') {
    await createDataOrderIfNeeded({ paymentId });
  }

  if (payment.type === 'AFA_PURCHASE') {
    await createAfaOrderIfNeeded({ paymentId });
  }
}

router.post('/webhook/paystack', async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) {
      return res.status(401).send('Invalid signature');
    }

    res.sendStatus(200);

    const event = req.body || {};
    if (event.event !== 'charge.success') return;

    const reference = event.data?.reference;
    if (!reference) return;

    const paymentsQuery = await db()
      .collection('payments')
      .where('clientReference', '==', reference)
      .limit(1)
      .get();

    if (paymentsQuery.empty) return;

    const paymentDoc = paymentsQuery.docs[0];
    const paymentId = paymentDoc.id;

    const verification = await verifyPaystackPayment({ reference });

    await db().collection('payments').doc(paymentId).set({
      providerReference: verification.providerReference || reference,
      providerTransactionId: verification.providerTransactionId || '',
      status: verification.status,
      message: verification.message || '',
      failureReason:
        verification.status === 'FAILED'
          ? (verification.message || 'Payment failed')
          : '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (verification.status === 'SUCCESS') {
      await processSuccessfulPayment({ paymentId });
    }
  } catch (error) {
    console.error('Webhook handling failed:', error.response?.data || error);
  }
});

router.post('/wallet/initiate', requireFirebaseUser, async (req, res) => {
  try {
    const { userId, amount, phoneNumber, network } = req.body;

    if (!userId || req.user.uid !== userId) {
      return res.status(403).json({ ok: false, message: 'User mismatch' });
    }

    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ ok: false, message: 'Amount must be greater than zero' });
    }

    const baseAmount = roundMoney(parsedAmount);
    const chargeAmount = calculatePaystackCharge(baseAmount);
    const totalPayableAmount = calculateTotalPayable(baseAmount);

    if (!/^[0-9]{10,15}$/.test(String(phoneNumber || '').trim())) {
      return res.status(400).json({ ok: false, message: 'Invalid phone number' });
    }

    const userRecord = await admin.auth().getUser(userId);
    await ensureWallet({
      userId,
      email: userRecord.email || '',
      displayName: userRecord.displayName || ''
    });

    const paymentRef = db().collection('payments').doc();
    const clientReference = generateClientReference('WALLET');
    const trackingId = generateTrackingId();

    await paymentRef.set({
      paymentId: paymentRef.id,
      userId,
      type: 'WALLET_FUNDING',
      provider: 'PAYSTACK',
      amount: baseAmount,
      chargeAmount,
      payableAmount: totalPayableAmount,
      currency: 'GHS',
      customerName: userRecord.displayName || '',
      customerEmail: userRecord.email || '',
      phoneNumber: String(phoneNumber).trim(),
      network: String(network || '').trim(),
      clientReference,
      providerReference: '',
      providerTransactionId: '',
      authorizationUrl: '',
      accessCode: '',
      status: 'INITIATED',
      walletCreditApplied: false,
      failureReason: '',
      message: 'Payment initialized.',
      trackingId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const callbackBase = process.env.APP_BASE_URL || '';
    const callbackUrl = callbackBase
      ? `${callbackBase}/api/payments/${paymentRef.id}/callback`
      : undefined;

    const paystackResponse = await initializePaystackWalletCharge({
      email: userRecord.email,
      amount: totalPayableAmount,
      clientReference,
      callbackUrl,
      metadata: {
        userId,
        paymentId: paymentRef.id,
        type: 'WALLET_FUNDING',
        phoneNumber: String(phoneNumber).trim(),
        network: String(network || '').trim(),
        trackingId,
        paymentChannel: 'general',
        baseAmount,
        chargeAmount,
        payableAmount: totalPayableAmount
      }
    });

    await paymentRef.set({
      providerReference: paystackResponse.providerReference || clientReference,
      authorizationUrl: paystackResponse.authorizationUrl || '',
      accessCode: paystackResponse.accessCode || '',
      status: paystackResponse.status || 'PENDING',
      message: paystackResponse.message || 'Payment initialized successfully.',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({
      ok: true,
      paymentId: paymentRef.id,
      status: paystackResponse.status || 'PENDING',
      clientReference,
      amount: baseAmount,
      chargeAmount,
      payableAmount: totalPayableAmount,
      authorizationUrl: paystackResponse.authorizationUrl || '',
      accessCode: paystackResponse.accessCode || '',
      message: paystackResponse.message || 'Payment initialized successfully.'
    });
  } catch (error) {
    console.error('Wallet initiate failed:', error.response?.data || error);
    return res.status(500).json({
      ok: false,
      message: error.response?.data?.message || error.message || 'Failed to initiate wallet payment'
    });
  }
});

router.post('/data/initiate', requireFirebaseUser, async (req, res) => {
  try {
    const { userId, amount, phoneNumber, network, bundleLabel, bundleValue } = req.body;

    if (!userId || req.user.uid !== userId) {
      return res.status(403).json({ ok: false, message: 'User mismatch' });
    }

    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ ok: false, message: 'Amount must be greater than zero' });
    }

    const baseAmount = roundMoney(parsedAmount);
    const chargeAmount = calculatePaystackCharge(baseAmount);
    const totalPayableAmount = calculateTotalPayable(baseAmount);

    if (!/^[0-9]{10,15}$/.test(String(phoneNumber || '').trim())) {
      return res.status(400).json({ ok: false, message: 'Invalid phone number' });
    }

    const userRecord = await admin.auth().getUser(userId);
    const paymentRef = db().collection('payments').doc();
    const clientReference = generateClientReference('DATA');
    const trackingId = generateTrackingId();
    const orderReference = generateOrderReference(network);

    await paymentRef.set({
      paymentId: paymentRef.id,
      userId,
      type: 'DATA_PURCHASE',
      provider: 'PAYSTACK',
      amount: baseAmount,
      chargeAmount,
      payableAmount: totalPayableAmount,
      currency: 'GHS',
      customerName: userRecord.displayName || '',
      customerEmail: userRecord.email || '',
      phoneNumber: String(phoneNumber).trim(),
      network: String(network || '').trim(),
      bundleLabel: String(bundleLabel || '').trim(),
      bundleValue: String(bundleValue || '').trim(),
      clientReference,
      providerReference: '',
      providerTransactionId: '',
      authorizationUrl: '',
      accessCode: '',
      status: 'INITIATED',
      orderCreated: false,
      orderId: '',
      orderReference,
      failureReason: '',
      message: 'Data payment initialized.',
      trackingId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const callbackBase = process.env.APP_BASE_URL || '';
    const callbackUrl = callbackBase
      ? `${callbackBase}/api/payments/${paymentRef.id}/callback`
      : undefined;

    const paystackResponse = await initializePaystackWalletCharge({
      email: userRecord.email,
      amount: totalPayableAmount,
      clientReference,
      callbackUrl,
      channels: ['mobile_money'],
      metadata: {
        userId,
        paymentId: paymentRef.id,
        type: 'DATA_PURCHASE',
        phoneNumber: String(phoneNumber).trim(),
        network: String(network || '').trim(),
        bundleLabel: String(bundleLabel || '').trim(),
        bundleValue: String(bundleValue || '').trim(),
        trackingId,
        paymentChannel: 'mobile_money',
        baseAmount,
        chargeAmount,
        payableAmount: totalPayableAmount
      }
    });

    await paymentRef.set({
      providerReference: paystackResponse.providerReference || clientReference,
      authorizationUrl: paystackResponse.authorizationUrl || '',
      accessCode: paystackResponse.accessCode || '',
      status: paystackResponse.status || 'PENDING',
      message: 'Authorization URL created',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({
      ok: true,
      paymentId: paymentRef.id,
      status: paystackResponse.status || 'PENDING',
      clientReference,
      amount: baseAmount,
      chargeAmount,
      payableAmount: totalPayableAmount,
      authorizationUrl: paystackResponse.authorizationUrl || '',
      accessCode: paystackResponse.accessCode || '',
      message: 'Authorization URL created'
    });
  } catch (error) {
    console.error('Data initiate failed:', error.response?.data || error);
    return res.status(500).json({
      ok: false,
      message: error.response?.data?.message || error.message || 'Failed to initialize data payment'
    });
  }
});

router.post('/afa/initiate', requireFirebaseUser, async (req, res) => {
  try {
    const { userId, amount, phoneNumber, fullName, ghaCardNumber, town } = req.body;

    if (!userId || req.user.uid !== userId) {
      return res.status(403).json({ ok: false, message: 'User mismatch' });
    }

    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ ok: false, message: 'Amount must be greater than zero' });
    }

    const baseAmount = roundMoney(parsedAmount);
    const chargeAmount = calculatePaystackCharge(baseAmount);
    const totalPayableAmount = calculateTotalPayable(baseAmount);

    if (!/^[0-9]{10,15}$/.test(String(phoneNumber || '').trim())) {
      return res.status(400).json({ ok: false, message: 'Invalid phone number' });
    }

    const userRecord = await admin.auth().getUser(userId);
    const paymentRef = db().collection('payments').doc();
    const clientReference = generateClientReference('AFA');
    const trackingId = generateTrackingId();
    const orderReference = generateOrderReference('AFA');

    await paymentRef.set({
      paymentId: paymentRef.id,
      userId,
      type: 'AFA_PURCHASE',
      provider: 'PAYSTACK',
      amount: baseAmount,
      chargeAmount,
      payableAmount: totalPayableAmount,
      currency: 'GHS',
      customerName: userRecord.displayName || fullName || '',
      customerEmail: userRecord.email || '',
      fullName: String(fullName || '').trim(),
      phoneNumber: String(phoneNumber).trim(),
      ghaCardNumber: String(ghaCardNumber || '').trim(),
      town: String(town || '').trim(),
      network: 'AFA',
      clientReference,
      providerReference: '',
      providerTransactionId: '',
      authorizationUrl: '',
      accessCode: '',
      status: 'INITIATED',
      orderCreated: false,
      orderId: '',
      orderReference,
      failureReason: '',
      message: 'AFA payment initialized.',
      trackingId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const callbackBase = process.env.APP_BASE_URL || '';
    const callbackUrl = callbackBase
      ? `${callbackBase}/api/payments/${paymentRef.id}/callback`
      : undefined;

    const paystackResponse = await initializePaystackWalletCharge({
      email: userRecord.email,
      amount: totalPayableAmount,
      clientReference,
      callbackUrl,
      channels: ['mobile_money'],
      metadata: {
        userId,
        paymentId: paymentRef.id,
        type: 'AFA_PURCHASE',
        phoneNumber: String(phoneNumber).trim(),
        fullName: String(fullName || '').trim(),
        ghaCardNumber: String(ghaCardNumber || '').trim(),
        town: String(town || '').trim(),
        trackingId,
        paymentChannel: 'mobile_money',
        baseAmount,
        chargeAmount,
        payableAmount: totalPayableAmount
      }
    });

    await paymentRef.set({
      providerReference: paystackResponse.providerReference || clientReference,
      authorizationUrl: paystackResponse.authorizationUrl || '',
      accessCode: paystackResponse.accessCode || '',
      status: paystackResponse.status || 'PENDING',
      message: 'Authorization URL created',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({
      ok: true,
      paymentId: paymentRef.id,
      status: paystackResponse.status || 'PENDING',
      clientReference,
      amount: baseAmount,
      chargeAmount,
      payableAmount: totalPayableAmount,
      authorizationUrl: paystackResponse.authorizationUrl || '',
      accessCode: paystackResponse.accessCode || '',
      message: 'Authorization URL created'
    });
  } catch (error) {
    console.error('AFA initiate failed:', error.response?.data || error);
    return res.status(500).json({
      ok: false,
      message: error.response?.data?.message || error.message || 'Failed to initialize AFA payment'
    });
  }
});

router.get('/:paymentId/status', requireFirebaseUser, async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    const paymentRef = db().collection('payments').doc(paymentId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.status(404).json({ ok: false, message: 'Payment not found' });
    }

    const payment = paymentSnap.data();

    if (payment.userId !== req.user.uid) {
      return res.status(403).json({ ok: false, message: 'Forbidden' });
    }

    const verification = await verifyPaystackPayment({
      reference: payment.clientReference
    });

    await paymentRef.set({
      providerReference: verification.providerReference || payment.clientReference,
      providerTransactionId: verification.providerTransactionId || '',
      status: verification.status,
      message: verification.message || '',
      failureReason: verification.status === 'FAILED' ? (verification.message || 'Payment failed') : '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (verification.status === 'SUCCESS') {
      await processSuccessfulPayment({ paymentId });
    }

    const freshSnap = await paymentRef.get();
    const fresh = freshSnap.data();

    let message = fresh.message || '';
    if (fresh.status === 'SUCCESS' && fresh.type === 'DATA_PURCHASE') {
      message = 'Order placed successfully.';
    } else if (fresh.status === 'SUCCESS' && fresh.type === 'AFA_PURCHASE') {
      message = 'AFA request submitted successfully.';
    }

    return res.json({
      ok: true,
      paymentId: fresh.paymentId,
      status: fresh.status,
      walletCreditApplied: fresh.walletCreditApplied === true,
      message
    });
  } catch (error) {
    console.error('Get payment status failed:', error.response?.data || error);
    return res.status(500).json({
      ok: false,
      message: error.response?.data?.message || error.message || 'Failed to get payment status'
    });
  }
});

router.get('/:paymentId/callback', async (req, res) => {
  return res.send('Payment callback received. Return to the app.');
});

module.exports = router;