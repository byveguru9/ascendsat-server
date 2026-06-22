const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

app.use(cors());
app.use(express.json());

// General rate limit — applies to all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // max 100 requests per IP per 15 minutes
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limit specifically for checkout — prevents abuse
const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // max 10 checkout attempts per IP per hour
  message: { error: "Too many checkout attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
  const { priceId, userId, successUrl, cancelUrl } = req.body;

  if (!priceId || !userId) {
    return res.status(400).json({ error: "Missing priceId or userId" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: successUrl || "https://ascendsat.com/dashboard?upgrade=success",
      cancel_url: cancelUrl || "https://ascendsat.com/dashboard?upgrade=canceled",
      metadata: {
        userId: userId,
      },
      automatic_tax: { enabled: true },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Stripe error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Stripe server running on port ${PORT}`));
