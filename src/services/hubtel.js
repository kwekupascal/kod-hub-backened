function generateClientReference(prefix = 'WALLET') {
  const now = Date.now().toString();
  return `${prefix}-${now.slice(-10)}`;
}

/**
 * Replace this mock function with the real Hubtel API request later.
 */
async function initiateHubtelWalletCharge({ amount, phoneNumber, network }) {
  return {
    providerReference: `HUBTEL-${Date.now()}`,
    providerTransactionId: `txn_${Date.now()}`,
    status: 'PENDING',
    message: `Approval prompt sent to ${phoneNumber} on ${network} for GHS ${amount}.`
  };
}

/**
 * Replace this with real Hubtel transaction lookup later.
 */
async function verifyHubtelPayment({ payment }) {
  return {
    status: payment.status || 'PENDING',
    message: payment.message || 'Still waiting for approval.'
  };
}

module.exports = {
  generateClientReference,
  initiateHubtelWalletCharge,
  verifyHubtelPayment
};
