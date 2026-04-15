require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { initializeFirebase } = require('./lib/firebase');
const { startAdminOrderNotificationsListener } = require('./services/adminNotifications');
const paymentsRouter = require('./routes/payments');
const webhooksRouter = require('./routes/webhooks');

initializeFirebase();
startAdminOrderNotificationsListener();

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'Paystack wallet backend is running.'
  });
});

app.get('/__render-check', (req, res) => {
  res.json({
    ok: true,
    message: 'Render is serving the latest src backend build',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/payments', paymentsRouter);
app.use('/api/webhooks', webhooksRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    ok: false,
    message: err.message || 'Internal server error'
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});