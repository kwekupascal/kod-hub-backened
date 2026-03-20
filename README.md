# Hubtel Wallet Backend Starter

This is a starter backend for Flutter wallet funding with:
- Express
- Firebase Admin
- Firestore
- Hubtel placeholder service
- Wallet funding initiate endpoint
- Payment status endpoint
- Hubtel webhook endpoint

## 1. Install
```bash
npm install
```

## 2. Add Firebase service account
Put your Firebase admin service account JSON at the project root and name it:

```text
serviceAccountKey.json
```

Or change `FIREBASE_SERVICE_ACCOUNT_PATH` in `.env`.

## 3. Create environment file
Copy `.env.example` to `.env` and fill in your values.

## 4. Run
```bash
npm run dev
```

## Endpoints
- `POST /api/payments/wallet/initiate`
- `GET /api/payments/:paymentId/status`
- `POST /api/webhooks/hubtel/payments`

## Important
This starter uses a mock Hubtel request right now so you can wire your app first.
Replace the placeholder logic in `src/services/hubtel.js` with the real Hubtel API request later.
