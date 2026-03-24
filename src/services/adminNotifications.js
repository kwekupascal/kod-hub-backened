const axios = require('axios');
const { db, admin } = require('../lib/firebase');

let listenerStarted = false;
let listenerUnsubscribe = null;

function money(value) {
  const amount = Number(value || 0);
  return Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2);
}

function buildNotificationPayload(orderId, order = {}) {
  const type = String(order.type || 'ORDER').toUpperCase();
  const trackingId = String(order.trackingId || '').trim();
  const amount = `GHS ${money(order.amount)}`;
  const status = String(order.status || 'Accepted').trim();

  if (type === 'AFA') {
    const fullName = String(order.fullName || order.customerName || 'Unknown customer').trim();
    const phone = String(order.phone || order.msisdn || '-').trim();
    return {
      title: 'New AFA order received',
      body: `${fullName} • ${phone} • ${amount}`,
      smsBody: `KOD HUB ALERT: New AFA order from ${fullName}. Phone: ${phone}. Amount: ${amount}. Tracking ID: ${trackingId || '-'} . Status: ${status}.`,
      orderType: 'AFA',
      trackingId,
      amount: Number(order.amount || 0),
      phone,
      customerName: fullName,
      status,
    };
  }

  const network = String(order.network || '-').trim();
  const bundle = String(order.value || '-').trim();
  const phone = String(order.msisdn || order.phone || '-').trim();

  return {
    title: 'New data order received',
    body: `${network} • ${bundle} • ${amount}`,
    smsBody: `KOD HUB ALERT: New DATA order. Network: ${network}. Bundle: ${bundle}. Phone: ${phone}. Amount: ${amount}. Tracking ID: ${trackingId || '-'} . Status: ${status}.`,
    orderType: 'DATA',
    trackingId,
    amount: Number(order.amount || 0),
    phone,
    customerName: String(order.customerName || '').trim(),
    status,
    network,
    bundle,
  };
}

async function sendAdminSms(message) {
  const provider = String(process.env.SMS_PROVIDER || 'NONE').toUpperCase();
  const adminPhone = String(process.env.ADMIN_ALERT_PHONE || '').trim();

  if (!adminPhone) {
    return { skipped: true, reason: 'ADMIN_ALERT_PHONE is not configured' };
  }

  if (provider === 'NONE' || provider === '') {
    return { skipped: true, reason: 'SMS_PROVIDER is not configured' };
  }

  if (provider === 'ARKESEL') {
    const apiKey = process.env.ARKESEL_API_KEY;
    const sender = process.env.ARKESEL_SENDER_ID || 'KOD HUB';
    const baseUrl = process.env.ARKESEL_BASE_URL || 'https://sms.arkesel.com/api/v2/sms/send';

    if (!apiKey) {
      throw new Error('ARKESEL_API_KEY is missing');
    }

    await axios.post(
      baseUrl,
      {
        sender,
        message,
        recipients: [adminPhone],
      },
      {
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    return { skipped: false, provider: 'ARKESEL' };
  }

  if (provider === 'TERMII') {
    const apiKey = process.env.TERMII_API_KEY;
    const sender = process.env.TERMII_SENDER_ID || 'KOD HUB';
    const baseUrl = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com/api/sms/send';

    if (!apiKey) {
      throw new Error('TERMII_API_KEY is missing');
    }

    await axios.post(
      baseUrl,
      {
        api_key: apiKey,
        to: adminPhone,
        from: sender,
        sms: message,
        type: 'plain',
        channel: 'generic',
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    return { skipped: false, provider: 'TERMII' };
  }

  throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
}

async function createAdminNotificationForOrder(orderDoc) {
  const orderId = orderDoc.id;
  const orderRef = orderDoc.ref;
  const notificationRef = db().collection('admin_notifications').doc(`order_${orderId}`);

  const result = await db().runTransaction(async (transaction) => {
    const freshOrderSnap = await transaction.get(orderRef);
    if (!freshOrderSnap.exists) {
      return { shouldNotify: false };
    }

    const freshOrder = freshOrderSnap.data() || {};
    if (freshOrder.adminNotificationCreated === true) {
      return { shouldNotify: false };
    }

    const payload = buildNotificationPayload(orderId, freshOrder);

    transaction.set(notificationRef, {
      notificationId: notificationRef.id,
      sourceOrderId: orderId,
      type: 'NEW_ORDER',
      orderType: payload.orderType,
      trackingId: payload.trackingId,
      amount: payload.amount,
      phone: payload.phone,
      customerName: payload.customerName,
      network: payload.network || '',
      bundle: payload.bundle || '',
      status: payload.status,
      title: payload.title,
      body: payload.body,
      isRead: false,
      smsStatus: 'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    transaction.set(orderRef, {
      adminNotificationCreated: true,
      adminNotificationCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      shouldNotify: true,
      payload,
      notificationId: notificationRef.id,
    };
  });

  if (!result.shouldNotify) return result;

  try {
    const smsResult = await sendAdminSms(result.payload.smsBody);
    await notificationRef.set({
      smsStatus: smsResult.skipped ? 'SKIPPED' : 'SENT',
      smsProvider: smsResult.provider || '',
      smsReason: smsResult.reason || '',
      smsSentAt: smsResult.skipped
        ? null
        : admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    await notificationRef.set({
      smsStatus: 'FAILED',
      smsReason: error.message || 'SMS failed',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.error('Admin SMS notification failed:', error.response?.data || error.message || error);
  }

  return result;
}

function startAdminOrderNotificationsListener() {
  if (listenerStarted) return listenerUnsubscribe;

  let initialSnapshotHandled = false;

  listenerUnsubscribe = db()
    .collection('orders')
    .onSnapshot(
      async (snapshot) => {
        if (!initialSnapshotHandled) {
          initialSnapshotHandled = true;
          console.log('Admin order notification listener is ready.');
          return;
        }

        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;
          try {
            await createAdminNotificationForOrder(change.doc);
          } catch (error) {
            console.error('Failed to process new order notification:', error.message || error);
          }
        }
      },
      (error) => {
        console.error('Admin order notification listener error:', error.message || error);
      }
    );

  listenerStarted = true;
  return listenerUnsubscribe;
}

module.exports = {
  startAdminOrderNotificationsListener,
  createAdminNotificationForOrder,
};