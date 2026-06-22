const stripe = require('stripe')('pk_live_51TkqMYBp80o2Bh0U2j4ZSZqGHGIydUl9m9klLHEnpGPYhyyC6k3m8iNAN4K715iPvdA16M0NdgJSFV1vxyby8P0A00FlhjwxBL');
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
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

app.listen(4242, () => console.log('Stripe server running on port 4242'));
