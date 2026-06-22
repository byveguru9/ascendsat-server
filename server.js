// ============================================================
// AscendSAT — Stripe + Firebase server
// Deploy: Render (Node 18+)
// ============================================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ── Firebase Admin init (SAFE) ───────────────────────────────
let db = null;

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    db = admin.firestore();
    console.log('Firebase Admin initialized');
  } catch (e) {
    console.error('Firebase Admin init failed:', e.message);
    db = null;
  }
}

// ── Express setup ────────────────────────────────────────────
const app = express();

// ── Stripe webhook (RAW BODY REQUIRED) ───────────────────────
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      return res.status(500).send('Webhook secret missing');
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // ── Checkout success ───────────────────────────────
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const uid = session.metadata?.userId;

        if (uid && db) {
          await db.collection('tiers').doc(uid).set(
            {
              tier: 'pro',
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              upgradedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );

          console.log(`Upgraded ${uid} to pro`);
        }
      }

      // ── Subscription canceled ──────────────────────────
      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;

        if (db) {
          const snap = await db
            .collection('tiers')
            .where('stripeCustomerId', '==', subscription.customer)
            .limit(1)
            .get();

          if (!snap.empty) {
            await snap.docs[0].ref.set(
              {
                tier: 'free',
                downgradedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
        }
      }
    } catch (e) {
      console.error('Webhook handler error:', e.message);
    }

    res.json({ received: true });
  }
);

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many checkout attempts, please try again later.' },
});

app.use(generalLimiter);

// ── Create Stripe Checkout Session ───────────────────────────
app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
  const { priceId, userId, successUrl, cancelUrl } = req.body;

  if (!priceId || !userId) {
    return res.status(400).json({ error: 'Missing priceId or userId' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      allow_promotion_codes: true,
      success_url: successUrl || 'https://ascendsat.com/dashboard',
      cancel_url: cancelUrl || 'https://ascendsat.com/dashboard',
      metadata: { userId },
      automatic_tax: { enabled: true },
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 4242;

app.listen(PORT, () => {
  console.log(`Stripe server running on port ${PORT}`);
});
