// ============================================================
// AscendSAT — Stripe + Firebase server
// Deploy: Render (Node 18+)
// Required env vars:
//   STRIPE_SECRET_KEY          — Stripe secret key
//   STRIPE_WEBHOOK_SECRET      — Stripe webhook signing secret
//                                (get from Stripe Dashboard → Webhooks)
//   FIREBASE_SERVICE_ACCOUNT   — full service-account JSON as a string
//                                (Settings → Service Accounts → Generate)
// ============================================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

// ── Firebase Admin init ──────────────────────────────────────
// Reads the full service-account JSON from an env variable so
// no credential file is committed to git.
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase Admin initialized');
  } catch (e) {
    console.error('Firebase Admin init error — set FIREBASE_SERVICE_ACCOUNT env var:', e.message);
  }
}
const db = admin.firestore();

// ── Express setup ────────────────────────────────────────────
const app = express();

// IMPORTANT: /webhook must receive the raw body for Stripe signature
// verification — register it BEFORE app.use(express.json()).
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error('STRIPE_WEBHOOK_SECRET not set');
      return res.status(500).send('Webhook secret missing');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const uid = session.metadata?.userId;
        if (!uid) {
          console.error('checkout.session.completed: no userId in metadata');
          return res.json({ received: true });
        }
        await db.collection('tiers').doc(uid).set({
          tier: 'pro',
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          upgradedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        console.log(`Upgraded ${uid} to pro`);
      }

      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        // Find user by stripeCustomerId
        const snap = await db
          .collection('tiers')
          .where('stripeCustomerId', '==', subscription.customer)
          .limit(1)
          .get();
        if (!snap.empty) {
          const docRef = snap.docs[0].ref;
          await docRef.set({
            tier: 'free',
            downgradedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          console.log(`Downgraded ${snap.docs[0].id} to free`);
        } else {
          console.warn('subscription.deleted: no user found for customer', subscription.customer);
        }
      }
    } catch (e) {
      console.error('Webhook handler error:', e.message);
      // Still return 200 so Stripe does not retry endlessly
    }

    res.json({ received: true });
  }
);

// ── Global middleware (after /webhook) ───────────────────────
app.use(cors());
app.use(express.json());

// General rate limit — applies to all remaining routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many checkout attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// ── Checkout session ─────────────────────────────────────────
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
    console.error('Stripe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Stripe server running on port ${PORT}`));
