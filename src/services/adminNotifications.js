const axios = require('axios');
const { db, admin } = require('../lib/firebase');

let listenersStarted = false;
let ordersUnsubscribe = null;
let walletTxUnsubscribe = null;

function money(value) {
  const amount = Number(value || 0);
  return Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2);
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d]/g, '').trim();
}

function isDeliveredStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  return normalized === 'DELIVERED' || normalized === 'COMPLETED';
}

async function getUserProfile(userId) {
  if (!userId) {
    return {
      fullName: '',
      email: '',
      phone: '',
    };
  }

  const userSnap = await db().collection('users').doc(userId).get();
  if (!userSnap.exists) {
    return {
      fullName: '',
      email: '',
      phone: '',
    };
  }

  const data = userSnap.data() || {};
  return {
    fullName: String(data.fullName || data.displayName || '').trim(),
    email: String(data.email || '').trim(),
    phone: normalizePhone(data.phone || ''),
  };
}

function buildNotificationPayload(orderId, order = {}) {
  const type = String(order.type || 'ORDER').toUpperCase();
  const trackingId = String(order.trackingId || '').trim();
  const amount = Number(order.amount || 0);
  const status = String(order.status || 'Accepted').trim();

  if (type === 'AFA') {
    const fullName = String(
      order.fullName || order.customerName || 'Unknown customer'
    ).trim();
    const phone = String(order.phone || order.msisdn || '-').trim();

    return {
      title: 'New AFA order received',
      body: 'New AFA order received',
      smsBody: 'New AFA order received',
      orderType: 'AFA',
      trackingId,
      amount,
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
    body: 'New data order received',
    smsBody: 'New data order received',
    orderType: 'DATA',
    trackingId,
    amount,
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

if (provider === 'ARKESEL') {
  const apiKey = String(process.env.ARKESEL_API_KEY || '').trim();
  const sender = String(process.env.ARKESEL_SENDER_ID || 'KOD HUB').trim();
  const baseUrl =
    process.env.ARKESEL_BASE_URL || 'https://sms.arkesel.com/api/v2/sms/send';

  if (!apiKey) {
    throw new Error('ARKESEL_API_KEY is missing');
  }

  const response = await axios.post(
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

  console.log('Arkesel SMS response:', response.data);
  return { skipped: false, provider: 'ARKESEL' };
}

  const network = String(order.network || '-').trim();
  const bundle = String(order.value || '-').trim();
  const phone = String(order.msisdn || order.phone || '-').trim();

  return {
    title: 'New data order',
    body: `${network} • ${bundle}`,
    smsBody: `New data order. ${network}. ${bundle}. ${phone}. ID ${trackingId || '-'}.`,
    orderType: 'DATA',
    trackingId,
    amount: Number(order.amount || 0),
    phone,
    customerName: String(order.customerName || '').trim(),
    status: String(order.status || 'Accepted').trim(),
    network,
    bundle,
  };
}

function buildCustomerAcceptedMessage(order = {}, customerName) {
  const type = String(order.type || '').trim().toUpperCase();

  if (type === 'AFA') {
    return `AFA request received. It is processing.`;
  }

  const network = String(order.network || 'Network').trim();
  const bundle = String(order.value || '').trim();
  return `${network} ${bundle} order received. Processing started.`;
}

function buildCustomerDeliveredMessage(order = {}, customerName) {
  const type = String(order.type || '').trim().toUpperCase();

  if (type === 'AFA') {
    return `AFA request completed successfully.`;
  }

  const network = String(order.network || 'Network').trim();
  const bundle = String(order.value || '').trim();
  return `${network} ${bundle} delivered successfully.`;
}

function buildCustomerFundingMessage({ customerName, amount, balanceAfter }) {
  return `Wallet funded: GHS ${money(amount)}. Balance: GHS ${money(balanceAfter)}.`;
}

function extractProviderMessageInfo(provider, responseData) {
  const safe =
    responseData && typeof responseData === 'object' ? responseData : {};

  if (provider === 'ARKESEL') {
    const messageId =
      safe.message_id ||
      safe.messageId ||
      safe.id ||
      safe.data?.message_id ||
      safe.data?.messageId ||
      safe.data?.id ||
      '';

    const reference =
      safe.reference ||
      safe.ref ||
      safe.data?.reference ||
      safe.data?.ref ||
      messageId ||
      '';

    return {
      providerMessageId: String(messageId || ''),
      providerReference: String(reference || ''),
    };
  }

  if (provider === 'TERMII') {
    const messageId =
      safe.message_id ||
      safe.messageId ||
      safe.code ||
      safe.data?.message_id ||
      safe.data?.messageId ||
      '';

    const reference =
      safe.reference ||
      safe.message_id ||
      safe.messageId ||
      messageId ||
      '';

    return {
      providerMessageId: String(messageId || ''),
      providerReference: String(reference || ''),
    };
  }

  return {
    providerMessageId: '',
    providerReference: '',
  };
}

async function sendSms({ to, message }) {
  const provider = String(process.env.SMS_PROVIDER || 'NONE')
    .trim()
    .toUpperCase();
  const recipient = normalizePhone(to);

  if (!recipient) {
    return {
      skipped: true,
      reason: 'Recipient phone is missing',
      provider,
      providerMessageId: '',
      providerReference: '',
      raw: null,
    };
  }

  if (provider === 'NONE' || provider === '') {
    return {
      skipped: true,
      reason: 'SMS_PROVIDER is not configured',
      provider,
      providerMessageId: '',
      providerReference: '',
      raw: null,
    };
  }

  if (provider === 'ARKESEL') {
    const apiKey = String(process.env.ARKESEL_API_KEY || '').trim();
    const sender = String(process.env.ARKESEL_SENDER_ID || 'KOD HUB').trim();
    const baseUrl =
      process.env.ARKESEL_BASE_URL ||
      'https://sms.arkesel.com/api/v2/sms/send';

    if (!apiKey) {
      throw new Error('ARKESEL_API_KEY is missing');
    }

    const response = await axios.post(
      baseUrl,
      {
        sender,
        message,
        recipients: [recipient],
      },
      {
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );

    const raw = response.data || {};
    const ids = extractProviderMessageInfo('ARKESEL', raw);

    return {
      skipped: false,
      provider: 'ARKESEL',
      reason: '',
      providerMessageId: ids.providerMessageId,
      providerReference: ids.providerReference,
      raw,
    };
  }

  if (provider === 'TERMII') {
    const apiKey = String(process.env.TERMII_API_KEY || '').trim();
    const sender = String(process.env.TERMII_SENDER_ID || 'KOD HUB').trim();
    const baseUrl =
      process.env.TERMII_BASE_URL ||
      'https://api.ng.termii.com/api/sms/send';

    if (!apiKey) {
      throw new Error('TERMII_API_KEY is missing');
    }

    const response = await axios.post(
      baseUrl,
      {
        api_key: apiKey,
        to: recipient,
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

    const raw = response.data || {};
    const ids = extractProviderMessageInfo('TERMII', raw);

    return {
      skipped: false,
      provider: 'TERMII',
      reason: '',
      providerMessageId: ids.providerMessageId,
      providerReference: ids.providerReference,
      raw,
    };
  }

  throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
}

async function createAdminNotificationForOrder(orderDoc) {
  const orderId = orderDoc.id;
  const orderRef = orderDoc.ref;
  const notificationRef = db()
    .collection('admin_notifications')
    .doc(`order_${orderId}`);

  const result = await db().runTransaction(async (transaction) => {
    const freshOrderSnap = await transaction.get(orderRef);
    if (!freshOrderSnap.exists) {
      return { shouldNotify: false };
    }

    const freshOrder = freshOrderSnap.data() || {};
    if (freshOrder.adminNotificationCreated === true) {
      return { shouldNotify: false };
    }

    const payload = buildAdminNotificationPayload(orderId, freshOrder);

    transaction.set(
      notificationRef,
      {
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
        smsProvider: '',
        smsReason: '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    transaction.set(
      orderRef,
      {
        adminNotificationCreated: true,
        adminNotificationCreatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      shouldNotify: true,
      payload,
      notificationId: notificationRef.id,
    };
  });

  if (!result.shouldNotify) return result;

  try {
    const smsResult = await sendSms({
      to: process.env.ADMIN_ALERT_PHONE || '',
      message: result.payload.smsBody,
    });

    await notificationRef.set(
      {
        smsStatus: smsResult.skipped ? 'SKIPPED' : 'SENT',
        smsProvider: smsResult.provider || '',
        smsReason: smsResult.reason || '',
        smsProviderMessageId: smsResult.providerMessageId || '',
        smsProviderReference: smsResult.providerReference || '',
        smsResponseRaw: smsResult.raw || null,
        smsSentAt: smsResult.skipped
          ? null
          : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    await notificationRef.set(
      {
        smsStatus: 'FAILED',
        smsReason:
          error.response?.data?.message || error.message || 'SMS failed',
        smsResponseRaw: error.response?.data || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.error(
      'Admin SMS notification failed:',
      error.response?.data || error.message || error
    );
  }

  return result;
}

async function sendCustomerAcceptedSmsForOrder(orderDoc) {
  const orderRef = orderDoc.ref;

  const lock = await db().runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) return { shouldSend: false };

    const order = snap.data() || {};
    if (order.customerAcceptedSmsSent === true) {
      return { shouldSend: false };
    }

    transaction.set(
      orderRef,
      {
        customerAcceptedSmsLockedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      shouldSend: true,
      order,
    };
  });

  if (!lock.shouldSend) return;

  const profile = await getUserProfile(lock.order.userId);
  const customerName = String(
    lock.order.customerName || lock.order.fullName || profile.fullName || 'Customer'
  ).trim();
  const customerPhone = normalizePhone(
    lock.order.phone || lock.order.msisdn || profile.phone || ''
  );

  const smsMessage = buildCustomerAcceptedMessage(lock.order, customerName);

  try {
    const smsResult = await sendSms({
      to: customerPhone,
      message: smsMessage,
    });

    await orderRef.set(
      {
        customerAcceptedSmsSent: !smsResult.skipped,
        customerAcceptedSmsSentAt: smsResult.skipped
          ? null
          : admin.firestore.FieldValue.serverTimestamp(),
        customerAcceptedSmsStatus: smsResult.skipped ? 'SKIPPED' : 'SENT',
        customerAcceptedSmsReason: smsResult.reason || '',
        customerAcceptedSmsProvider: smsResult.provider || '',
        customerAcceptedSmsProviderMessageId:
          smsResult.providerMessageId || '',
        customerAcceptedSmsProviderReference:
          smsResult.providerReference || '',
        customerAcceptedSmsResponseRaw: smsResult.raw || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    await orderRef.set(
      {
        customerAcceptedSmsSent: false,
        customerAcceptedSmsStatus: 'FAILED',
        customerAcceptedSmsReason:
          error.response?.data?.message || error.message || 'SMS failed',
        customerAcceptedSmsResponseRaw: error.response?.data || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.error(
      'Customer accepted SMS failed:',
      error.response?.data || error.message || error
    );
  }
}

async function sendCustomerDeliveredSmsForOrder(orderDoc) {
  const orderRef = orderDoc.ref;

  const lock = await db().runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) return { shouldSend: false };

    const order = snap.data() || {};
    if (!isDeliveredStatus(order.status)) {
      return { shouldSend: false };
    }

    if (order.customerDeliveredSmsSent === true) {
      return { shouldSend: false };
    }

    transaction.set(
      orderRef,
      {
        customerDeliveredSmsLockedAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      shouldSend: true,
      order,
    };
  });

  if (!lock.shouldSend) return;

  const profile = await getUserProfile(lock.order.userId);
  const customerName = String(
    lock.order.customerName || lock.order.fullName || profile.fullName || 'Customer'
  ).trim();
  const customerPhone = normalizePhone(
    lock.order.phone || lock.order.msisdn || profile.phone || ''
  );

  const smsMessage = buildCustomerDeliveredMessage(lock.order, customerName);

  try {
    const smsResult = await sendSms({
      to: customerPhone,
      message: smsMessage,
    });

    await orderRef.set(
      {
        customerDeliveredSmsSent: !smsResult.skipped,
        customerDeliveredSmsSentAt: smsResult.skipped
          ? null
          : admin.firestore.FieldValue.serverTimestamp(),
        customerDeliveredSmsStatus: smsResult.skipped ? 'SKIPPED' : 'SENT',
        customerDeliveredSmsReason: smsResult.reason || '',
        customerDeliveredSmsProvider: smsResult.provider || '',
        customerDeliveredSmsProviderMessageId:
          smsResult.providerMessageId || '',
        customerDeliveredSmsProviderReference:
          smsResult.providerReference || '',
        customerDeliveredSmsResponseRaw: smsResult.raw || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    await orderRef.set(
      {
        customerDeliveredSmsSent: false,
        customerDeliveredSmsStatus: 'FAILED',
        customerDeliveredSmsReason:
          error.response?.data?.message || error.message || 'SMS failed',
        customerDeliveredSmsResponseRaw: error.response?.data || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.error(
      'Customer delivered SMS failed:',
      error.response?.data || error.message || error
    );
  }
}

async function sendCustomerFundingSms(txDoc) {
  const txRef = txDoc.ref;

  const lock = await db().runTransaction(async (transaction) => {
    const snap = await transaction.get(txRef);
    if (!snap.exists) return { shouldSend: false };

    const txData = snap.data() || {};
    if (
      String(txData.type || '').toUpperCase() !== 'CREDIT' ||
      String(txData.status || '').toUpperCase() !== 'SUCCESS'
    ) {
      return { shouldSend: false };
    }

    if (txData.customerFundingSmsSent === true) {
      return { shouldSend: false };
    }

    transaction.set(
      txRef,
      {
        customerFundingSmsLockedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      shouldSend: true,
      txData,
    };
  });

  if (!lock.shouldSend) return;

  const txData = lock.txData;
  const profile = await getUserProfile(txData.userId);
  const customerName = String(
    txData.customerName || profile.fullName || 'Customer'
  ).trim();
  const customerPhone = normalizePhone(
    txData.phone || profile.phone || ''
  );

  const smsMessage = buildCustomerFundingMessage({
    customerName,
    amount: Number(txData.amount || 0),
    balanceAfter: Number(txData.balanceAfter || 0),
  });

  try {
    const smsResult = await sendSms({
      to: customerPhone,
      message: smsMessage,
    });

    await txRef.set(
      {
        customerFundingSmsSent: !smsResult.skipped,
        customerFundingSmsSentAt: smsResult.skipped
          ? null
          : admin.firestore.FieldValue.serverTimestamp(),
        customerFundingSmsStatus: smsResult.skipped ? 'SKIPPED' : 'SENT',
        customerFundingSmsReason: smsResult.reason || '',
        customerFundingSmsProvider: smsResult.provider || '',
        customerFundingSmsProviderMessageId:
          smsResult.providerMessageId || '',
        customerFundingSmsProviderReference:
          smsResult.providerReference || '',
        customerFundingSmsResponseRaw: smsResult.raw || null,
      },
      { merge: true }
    );
  } catch (error) {
    await txRef.set(
      {
        customerFundingSmsSent: false,
        customerFundingSmsStatus: 'FAILED',
        customerFundingSmsReason:
          error.response?.data?.message || error.message || 'SMS failed',
        customerFundingSmsResponseRaw: error.response?.data || null,
      },
      { merge: true }
    );

    console.error(
      'Customer funding SMS failed:',
      error.response?.data || error.message || error
    );
  }
}

function startAdminOrderNotificationsListener() {
  if (listenersStarted) {
    return {
      ordersUnsubscribe,
      walletTxUnsubscribe,
    };
  }

  let initialOrdersSnapshotHandled = false;
  let initialWalletTxSnapshotHandled = false;

  ordersUnsubscribe = db()
    .collection('orders')
    .onSnapshot(
      async (snapshot) => {
        if (!initialOrdersSnapshotHandled) {
          initialOrdersSnapshotHandled = true;
          console.log('Admin order notification listener is ready.');
          return;
        }

        for (const change of snapshot.docChanges()) {
          try {
            if (change.type === 'added') {
              await createAdminNotificationForOrder(change.doc);
              await sendCustomerAcceptedSmsForOrder(change.doc);
            }

            if (change.type === 'modified') {
              await sendCustomerDeliveredSmsForOrder(change.doc);
            }
          } catch (error) {
            console.error(
              'Failed to process order notification flow:',
              error.message || error
            );
          }
        }
      },
      (error) => {
        console.error(
          'Admin order notification listener error:',
          error.message || error
        );
      }
    );

  walletTxUnsubscribe = db()
    .collection('wallet_transactions')
    .onSnapshot(
      async (snapshot) => {
        if (!initialWalletTxSnapshotHandled) {
          initialWalletTxSnapshotHandled = true;
          console.log('Wallet transaction SMS listener is ready.');
          return;
        }

        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;

          try {
            await sendCustomerFundingSms(change.doc);
          } catch (error) {
            console.error(
              'Failed to process wallet funding SMS:',
              error.message || error
            );
          }
        }
      },
      (error) => {
        console.error(
          'Wallet transaction SMS listener error:',
          error.message || error
        );
      }
    );

  listenersStarted = true;

  return {
    ordersUnsubscribe,
    walletTxUnsubscribe,
  };
}

module.exports = {
  startAdminOrderNotificationsListener,
  createAdminNotificationForOrder,
};