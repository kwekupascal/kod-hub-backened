const express = require('express');
const crypto = require('crypto');
const { db, admin } = require('../lib/firebase');
const { creditWalletIfNeeded } = require('../services/wallets');

const router = express.Router();

function verifySignature(req) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.headers['x-paystack-signature'];

  if (!secret || !signature || !req.rawBody) {
    return false;
  }

  const hash = crypto
    .createHmac('sha512', secret)
    .update(req.rawBody)
    .digest('hex');

  return hash === signature;
}

router.post('/paystack/payments', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).json({
        ok: false,
        message: 'Invalid Paystack signature'
      });
    }

    const payload = req.body || {};
    const event = String(payload.event || '');
    const data = payload.data || {};
    const reference = String(data.reference || '').trim();
    const paystackStatus = String(data.status || '').toLowerCase();

    if (!reference) {
      return res.status(400).json({
        ok: false,
        message: 'Missing transaction reference'
      });
    }

    const querySnap = await db()
      .collection('payments')
      .where('clientReference', '==', reference)
      .limit(1)
      .get();

    if (querySnap.empty) {
      return res.status(404).json({
        ok: false,
        message: 'Payment not found'
      });
    }

    const paymentDoc = querySnap.docs[0];
    const paymentRef = paymentDoc.ref;

    await db().collection('payment_events').add({
      paymentId: paymentDoc.id,
      provider: 'PAYSTACK',
      eventType: event || 'webhook',
      status: paystackStatus || 'unknown',
      raw: payload,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    let nextStatus = 'PENDING';
    if (paystackStatus === 'success') {
      nextStatus = 'SUCCESS';
    } else if (paystackStatus === 'failed') {
      nextStatus = 'FAILED';
    } else if (paystackStatus === 'abandoned') {
      nextStatus = 'CANCELLED';
    }

    await paymentRef.set({
      providerReference: reference,
      providerTransactionId: String(data.id || ''),
      status: nextStatus,
      message: String(data.gateway_response || data.message || `Payment updated to ${nextStatus}.`),
      failureReason: nextStatus === 'FAILED'
        ? String(data.gateway_response || data.message || 'Payment failed')
        : '',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (nextStatus === 'SUCCESS') {
      await creditWalletIfNeeded({ paymentId: paymentDoc.id });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('Paystack webhook failed:', error);
    return res.status(500).json({
      ok: false,
      message: error.message || 'Webhook handling failed'
    });
  }
});

module.exports = router;