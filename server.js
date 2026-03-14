/**
 * SOL PLAYER — BACKEND SERVER (RAILWAY FIXED)
 * Uses in-memory NeDB — no file system needed, works on all hosting platforms
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Datastore  = require('@seald-io/nedb');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // required for Railway

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── IN-MEMORY DATABASE (no file system required) ─────────────────────────
const licenses    = new Datastore();
const payments    = new Datastore();
const users       = new Datastore();
const activations = new Datastore();

licenses.ensureIndex({ fieldName: 'key',   unique: true });
users.ensureIndex(   { fieldName: 'email', unique: true });

const find    = (store, q)      => new Promise((res, rej) => store.find(q,    (e, d) => e ? rej(e) : res(d)));
const findOne = (store, q)      => new Promise((res, rej) => store.findOne(q, (e, d) => e ? rej(e) : res(d)));
const insert  = (store, doc)    => new Promise((res, rej) => store.insert(doc,(e, d) => e ? rej(e) : res(d)));
const update  = (store, q, upd) => new Promise((res, rej) => store.update(q, upd, {}, (e) => e ? rej(e) : res()));
const count   = (store, q = {}) => new Promise((res, rej) => store.count(q,  (e, n) => e ? rej(e) : res(n)));

console.log('✦ Database ready');

// ─── EMAIL ─────────────────────────────────────────────────────────────────
async function sendActivationEmail(email, name, key) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log(`[No email credentials] Key for ${email}: ${key}`);
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  try {
    await transporter.sendMail({
      from: `"SOL Player" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: '✦ Your SOL Player Activation Key',
      html: `
        <div style="background:#080808;color:#F5F0E8;font-family:Georgia,serif;padding:40px;max-width:520px;margin:0 auto;">
          <div style="font-size:28px;color:#C9A84C;letter-spacing:6px;text-align:center;margin-bottom:32px;">SOL PLAYER</div>
          <div style="background:#0F0F0F;border:1px solid rgba(201,168,76,0.3);padding:36px;">
            <p style="font-size:18px;font-weight:300;margin-bottom:16px;">Welcome, ${name || 'Valued Customer'}.</p>
            <p style="font-size:13px;color:rgba(245,240,232,0.7);line-height:1.9;font-family:sans-serif;margin-bottom:24px;">
              Your activation key is below. Open SOL Player on your TV, go to Settings → Activation, and enter this key.
            </p>
            <div style="background:#161616;border:1px solid #C9A84C;padding:20px;text-align:center;">
              <div style="font-size:9px;letter-spacing:3px;color:#C9A84C;margin-bottom:10px;font-family:sans-serif;">ACTIVATION KEY</div>
              <div style="font-size:20px;letter-spacing:4px;color:#E8C97A;font-family:monospace;">${key}</div>
            </div>
            <p style="font-size:11px;color:rgba(245,240,232,0.5);margin-top:20px;font-family:sans-serif;">Valid 1 year · Up to 3 devices</p>
          </div>
          <p style="text-align:center;font-size:10px;color:rgba(245,240,232,0.2);margin-top:20px;font-family:sans-serif;">solplayer.com</p>
        </div>`,
    });
    console.log(`✦ Email sent → ${email}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function generateKey() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const s = (n) => Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
  return `SOL-${s(4)}-${s(4)}-${s(4)}`;
}
function expiry(plan = 'annual') {
  const d = new Date();
  plan === 'lifetime' ? d.setFullYear(d.getFullYear() + 100) : d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: '✦ SOL Player server is running', time: new Date().toISOString() });
});

// ─── ADMIN AUTH ────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_TOKEN not set' });
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── PUBLIC ROUTES ─────────────────────────────────────────────────────────
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { email, name } = req.body;
    const pi = await stripe.paymentIntents.create({
      amount: 1400, currency: 'usd',
      metadata: { email: email || '', name: name || '' },
      receipt_email: email || undefined,
    });
    res.json({ clientSecret: pi.client_secret });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { paymentIntentId, email, name } = req.body;
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'succeeded') return res.status(400).json({ error: 'Payment not completed' });

    const existing = await findOne(licenses, { stripePayment: paymentIntentId });
    if (existing) return res.json({ key: existing.key, message: 'License already issued' });

    const key = generateKey();
    const now = new Date().toISOString();
    await insert(licenses, { key, email, name: name || '', plan: 'annual', price: 14, status: 'active', stripePayment: paymentIntentId, expiresAt: expiry(), devices: [], createdAt: now });
    await insert(payments, { stripeId: paymentIntentId, email, amount: 14, status: 'succeeded', licenseKey: key, createdAt: now }).catch(() => {});
    await insert(users,    { email, name: name || '', createdAt: now }).catch(() => {});
    await sendActivationEmail(email, name, key);
    res.json({ key, message: 'License created and emailed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/activate', async (req, res) => {
  const { key, deviceId, deviceName, platform } = req.body;
  if (!key || !deviceId) return res.status(400).json({ valid: false, message: 'Missing key or device ID' });

  const license = await findOne(licenses, { key: key.trim().toUpperCase() });
  if (!license)                    return res.status(404).json({ valid: false, message: 'Invalid activation key' });
  if (license.status !== 'active') return res.status(403).json({ valid: false, message: `License is ${license.status}` });
  if (new Date(license.expiresAt) < new Date()) {
    await update(licenses, { key }, { $set: { status: 'expired' } });
    return res.status(403).json({ valid: false, message: 'License expired. Renew at solplayer.com' });
  }

  const devices = license.devices || [];
  if (!devices.includes(deviceId)) {
    if (devices.length >= 3) return res.status(403).json({ valid: false, message: 'Device limit reached (3 max)' });
    await update(licenses, { key }, { $push: { devices: deviceId } });
  }

  await insert(activations, { licenseKey: key, deviceId, deviceName: deviceName || 'Unknown', platform: platform || 'Unknown', ip: req.ip, activatedAt: new Date().toISOString() }).catch(() => {});
  res.json({ valid: true, message: 'Activation successful', plan: license.plan, expiresAt: license.expiresAt, devicesUsed: devices.length + 1, devicesAllowed: 3 });
});

app.post('/api/check-trial', (req, res) => {
  const { installDate } = req.body;
  if (!installDate) return res.json({ trialActive: true, daysRemaining: 7 });
  const elapsed = Math.floor((Date.now() - new Date(installDate)) / 86400000);
  const daysRemaining = Math.max(0, 7 - elapsed);
  res.json({ trialActive: daysRemaining > 0, daysRemaining, expired: daysRemaining === 0 });
});

app.post('/api/resend-key', async (req, res) => {
  const { email } = req.body;
  const all = await find(licenses, { email, status: 'active' });
  if (!all.length) return res.status(404).json({ error: 'No active license found for this email' });
  const license = all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  await sendActivationEmail(email, license.name, license.key);
  res.json({ message: 'Key resent to ' + email });
});

// ─── STRIPE WEBHOOK ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  let event;
  try {
    event = process.env.STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const { email, name } = pi.metadata || {};
    const existing = await findOne(licenses, { stripePayment: pi.id });
    if (!existing && email) {
      const key = generateKey();
      const now = new Date().toISOString();
      await insert(licenses, { key, email, name: name || '', plan: 'annual', price: 14, status: 'active', stripePayment: pi.id, expiresAt: expiry(), devices: [], createdAt: now }).catch(() => {});
      await sendActivationEmail(email, name, key);
      console.log(`✦ Webhook license: ${key} → ${email}`);
    }
  }
  res.json({ received: true });
});

// ─── ADMIN ROUTES ──────────────────────────────────────────────────────────
app.get('/admin/stats', adminAuth, async (req, res) => {
  const [total, active, expired, totalUsers, totalPaid, allLicenses, allPayments] = await Promise.all([
    count(licenses), count(licenses, { status: 'active' }), count(licenses, { status: 'expired' }),
    count(users), count(payments, { status: 'succeeded' }),
    find(licenses, {}), find(payments, { status: 'succeeded' }),
  ]);
  const revenue = allPayments.reduce((s, p) => s + (p.amount || 0), 0);
  const recent  = allLicenses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
  res.json({ totalLicenses: total, activeLicenses: active, expiredLicenses: expired, totalRevenue: revenue, totalUsers, totalPayments: totalPaid, recentLicenses: recent });
});

app.get('/admin/licenses', adminAuth, async (req, res) => {
  const { search, status } = req.query;
  let all = await find(licenses, status ? { status } : {});
  if (search) {
    const s = search.toLowerCase();
    all = all.filter(l => l.email?.toLowerCase().includes(s) || l.key?.toLowerCase().includes(s) || l.name?.toLowerCase().includes(s));
  }
  all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ licenses: all, total: all.length });
});

app.post('/admin/generate-key', adminAuth, async (req, res) => {
  const { email, name, plan = 'annual' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const key = generateKey();
  const now = new Date().toISOString();
  await insert(licenses, { key, email, name: name || '', plan, price: 0, status: 'active', stripePayment: null, expiresAt: expiry(plan), devices: [], createdAt: now });
  await sendActivationEmail(email, name, key);
  res.json({ key, message: 'Key generated and emailed' });
});

app.post('/admin/revoke-key',  adminAuth, async (req, res) => { await update(licenses, { key: req.body.key }, { $set: { status: 'revoked' } }); res.json({ message: 'Revoked'  }); });
app.post('/admin/restore-key', adminAuth, async (req, res) => { await update(licenses, { key: req.body.key }, { $set: { status: 'active'  } }); res.json({ message: 'Restored' }); });

app.get('/admin/payments', adminAuth, async (req, res) => {
  const all = (await find(payments, {})).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ payments: all });
});

// ─── START ─────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  ✦  SOL PLAYER SERVER RUNNING       ║
  ║     ${HOST}:${PORT}                        ║
  ╚══════════════════════════════════════╝
  `);
});
