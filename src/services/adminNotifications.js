function buildAdminNotificationPayload(orderId, order = {}) {
  const type = String(order.type || 'ORDER').toUpperCase();
  const trackingId = String(order.trackingId || '').trim();

  if (type === 'AFA') {
    const fullName = String(
      order.fullName || order.customerName || 'Customer'
    ).trim();
    const phone = String(order.phone || order.msisdn || '-').trim();

    return {
      title: 'New AFA order',
      body: `${fullName} • ${phone}`,
      smsBody: `New AFA order. ${fullName}. ${phone}. ID ${trackingId || '-'}.`,
      orderType: 'AFA',
      trackingId,
      amount: Number(order.amount || 0),
      phone,
      customerName: fullName,
      status: String(order.status || 'Accepted').trim(),
    };
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