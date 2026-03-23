const axios = require('axios');

function getPaystackHeaders() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('PAYSTACK_SECRET_KEY is missing in .env');
  }

  return {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json'
  };
}

function generateClientReference(prefix = 'WALLET') {
  const now = Date.now().toString();
  return `${prefix}-${now.slice(-10)}`;
}

async function initializePaystackWalletCharge({
  email,
  amount,
  clientReference,
  callbackUrl,
  metadata,
  channels
}) {
  const baseUrl = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

  const payload = {
    email,
    amount: Math.round(Number(amount) * 100),
    reference: clientReference,
    callback_url: callbackUrl,
    metadata
  };

  if (Array.isArray(channels) && channels.length > 0) {
    payload.channels = channels;
  }

  const response = await axios.post(
    `${baseUrl}/transaction/initialize`,
    payload,
    {
      headers: getPaystackHeaders()
    }
  );

  const data = response.data || {};

  if (data.status !== true || !data.data) {
    throw new Error(data.message || 'Failed to initialize Paystack transaction');
  }

  return {
    providerReference: data.data.reference || clientReference,
    authorizationUrl: data.data.authorization_url || '',
    accessCode: data.data.access_code || '',
    status: 'PENDING',
    message: data.message || 'Payment initialized successfully.'
  };
}

async function verifyPaystackPayment({ reference }) {
  const baseUrl = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';

  const response = await axios.get(
    `${baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: getPaystackHeaders()
    }
  );

  const data = response.data || {};
  if (data.status !== true || !data.data) {
    throw new Error(data.message || 'Failed to verify Paystack transaction');
  }

  const tx = data.data;
  const paystackStatus = String(tx.status || '').toLowerCase();

  let mappedStatus = 'PENDING';
  if (paystackStatus === 'success') {
    mappedStatus = 'SUCCESS';
  } else if (paystackStatus === 'failed') {
    mappedStatus = 'FAILED';
  } else if (paystackStatus === 'abandoned') {
    mappedStatus = 'CANCELLED';
  }

  return {
    status: mappedStatus,
    providerReference: tx.reference || reference,
    providerTransactionId: String(tx.id || ''),
    message: tx.gateway_response || tx.message || data.message || '',
    amount: Number(tx.amount || 0) / 100,
    raw: tx
  };
}

module.exports = {
  generateClientReference,
  initializePaystackWalletCharge,
  verifyPaystackPayment
};