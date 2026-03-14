/**
 * SOL PLAYER — BACKEND SERVER (FIXED)
 * =====================================
 * Uses NeDB instead of better-sqlite3
 * NeDB is pure JavaScript — no compilation needed, works on Railway/Render/everywhere
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const Datastore  = require('@seald-io/nedb');
const stripe     = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── DATABASE SETUP (NeDB — pure JavaScript, no compilation) ──────────────
const db = {
  licenses:    new Datastore({ filename: './data/licenses.db',    autoload: true }),
  payments:    new Datastore({ filename: './data/payments.db',    autoload: true }),
  users:       new Datastore({ filename: './data/users.db',       autoload: true }),
  activations: new Datastore({ filename: './data/activations.db', autoload: true }),
};

// Create indexes
db.licenses.ensureIndex({ fieldName: 'key',      unique: true });
db.licenses.ensureIndex({ fieldName: 'email' });
db.payments.ensureIndex({ fieldName: 'stripeId', unique: true, sparse: true });
db.users.ensureIndex(   { fieldName: 'email',    unique: true });

// Promisify NeDB methods
const dbFind    = (store, query)        => new Promise((res, rej) => store.find(query,         (e, d) => e ? rej(e) : res(d)));
const dbFindOne = (store, query)        => new Promise((res, rej) => store.findOne(query,      (e, d) => e ? rej(e) : res(d)));
const dbInsert  = (store, doc)          => new Promise((res, rej) => store.insert(doc,         (e, d) => e ? rej(e) : res(d)));
const dbUpdate  = (store, query, upd)   => new Promise((res, rej) => store.update(query, upd, {}, (e) => e ? rej(e) : res()));
const dbCount   = (store, query = {})   => new Promise((res, rej) => store.count(query,        (e, n) => e ? rej(e) : res(n)));

console.log('✦ Database ready (NeDB)');

// ─── EMAIL ─────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
  },
});

async function sendActivationEmail(email, name, licenseKey) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log(`[Email skipped — no credentials] Key for ${email}: ${licenseKey}`);
    return;
  }
  const html = `
    <div style="background:#080808;color:#F5F0E8;font-family:Georgia,serif;padding:40px;max-width:560px;margin:0 auto;">
      <div style="font-size:32px;color:#C9A84C;letter-spacing:6px;text-align:center;margin-bottom:40px;">SOL PLAYER</div>
      <div style="background:#0F0F0F;border:1px solid rgba(201,168,76,0.3);padding:40px;">
        <div style="height:2px;background:linear-gradient(to right,transparent,#C9A84C,transparent);margin:-40px -40px 32px;"></div>
        <p style="font-size:20px;font-weight:300;margin-bottom:16px;">Welcome, ${name || 'Valued Customer'}.</p>
        <p style="font-size:13px;color:rgba(245,240,232,0.7);line-height:1.9;margin-bottom:28px;font-family:sans-serif;">
          Your SOL Player license key is below. Enter it in the app under <strong>Settings → Activation</strong>.
        </p>
        <div style="background:#161616;border:1px solid #C9A84C;padding:24px;text-align:center;margin:28px 0;">
          <div style="font-size:9px;letter-spacing:4px;text-transform:uppercase;color:#C9A84C;margin-bottom:12px;font-family:sans-serif;">Your Activation Key</div>
          <div style="font-size:22px;letter-spacing:4px;color:#E8C97A;font-family:monospace;">${licenseKey}</div>
        </div>
        <p style="font-size:12px;color:rgba(245,240,232,0.6);line-height:1.9;font-family:sans-serif;">
          Valid for <strong>1 year</strong> · Up to <strong>3 devices</strong>
        </p>
      </div>
      <div style="text-align:center;margin-top:24px;font-size:10px;color:rgba(245,240,232,0.25);font-family:sans-serif;">
        © SOL Player · If you didn't make this purchase, contact support@solplayer.com
      </div>
    </div>`;
  try {
    await transporter.sendMail({
      from: `"SOL Player" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: '✦ Your SOL Player Activation Key',
      html,
    });
    console.log(`✦ Email sent to ${email}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function generateLicenseKey() {
  const chars   = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segment = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SOL-${segment(4)}-${segment(4)}-${segment(4)}`;
}

function getExpiryDate(plan = 'annual') {
  const d = new Date();
  plan === 'lifetime' ? d.setFullYear(d.getFullYear() + 100) : d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'SOL Player server running ✦', time: new Date().toISOString() });
});

// ─── ADMIN AUTH ────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'ADMIN_TOKEN environment variable not set' });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── PUBLIC ROUTES ─────────────────────────────────────────────────────────

// Create Stripe payment intent
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { email, name } = req.body;
    const pi = await stripe.paymentIntents.create({
      amount: 1400,
      currency: 'usd',
      metadata: { email: email || '', name: name || '' },
      receipt_email: email || undefined,
    });
    res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify payment and issue license
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { paymentIntentId, email, name } = req.body;
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed' });
    }

    const existing = await dbFindOne(db.licenses, { stripePayment: paymentIntentId });
    if (existing) return res.json({ key: existing.key, message: 'License already issued' });

    const key       = generateLicenseKey();
    const expiresAt = getExpiryDate('annual');
    const now       = new Date().toISOString();

    await dbInsert(db.licenses, { key, email, name: name || '', plan: 'annual', price: 14, status: 'active', stripePayment: paymentIntentId, activatedAt: now, expiresAt, devices: [], createdAt: now });
    await dbInsert(db.payments, { stripeId: paymentIntentId, email, amount: 14, currency: 'usd', status: 'succeeded', licenseKey: key, createdAt: now }).catch(() => {});
    await dbInsert(db.users,    { email, name: name || '', createdAt: now }).catch(() => {});

    await sendActivationEmail(email, name, key);
    res.json({ key, expiresAt, message: 'License created and emailed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validate activation key (called by TV app)
app.post('/api/activate', async (req, res) => {
  const { key, deviceId, deviceName, platform } = req.body;
  if (!key || !deviceId) return res.status(400).json({ valid: false, message: 'Missing key or device ID' });

  const license = await dbFindOne(db.licenses, { key: key.trim().toUpperCase() });
  if (!license)                    return res.status(404).json({ valid: false, message: 'Invalid activation key' });
  if (license.status !== 'active') return res.status(403).json({ valid: false, message: `License is ${license.status}` });
  if (new Date(license.expiresAt) < new Date()) {
    await dbUpdate(db.licenses, { key }, { $set: { status: 'expired' } });
    return res.status(403).json({ valid: false, message: 'License expired. Please renew at solplayer.com' });
  }

  const devices = license.devices || [];
  if (!devices.includes(deviceId)) {
    if (devices.length >= 3) return res.status(403).json({ valid: false, message: 'Device limit reached (max 3 devices)' });
    await dbUpdate(db.licenses, { key }, { $push: { devices: deviceId } });
  }

  await dbInsert(db.activations, { licenseKey: key, deviceId, deviceName: deviceName || 'Unknown', platform: platform || 'Unknown', ip: req.ip, activatedAt: new Date().toISOString() }).catch(() => {});

  res.json({ valid: true, message: 'Activation successful', plan: license.plan, expiresAt: license.expiresAt, devicesUsed: devices.length + 1, devicesAllowed: 3 });
});

// Check trial status (called by TV app on launch)
app.post('/api/check-trial', (req, res) => {
  const { installDate } = req.body;
  if (!installDate) return res.json({ trialActive: true, daysRemaining: 7 });
  const elapsed      = Math.floor((Date.now() - new Date(installDate)) / 86400000);
  const daysRemaining = Math.max(0, 7 - elapsed);
  res.json({ trialActive: daysRemaining > 0, daysRemaining, expired: daysRemaining === 0 });
});

// Resend key by email
app.post('/api/resend-key', async (req, res) => {
  const { email } = req.body;
  const licenses  = await dbFind(db.licenses, { email, status: 'active' });
  if (!licenses.length) return res.status(404).json({ error: 'No active license found for this email' });
  const license = licenses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  await sendActivationEmail(email, license.name, license.key);
  res.json({ message: 'Key resent to ' + email });
});

// ─── STRIPE WEBHOOK ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(req.body, sig, webhookSecret)
      : JSON.parse(req.body);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi    = event.data.object;
    const email = pi.metadata?.email;
    const name  = pi.metadata?.name;
    const existing = await dbFindOne(db.licenses, { stripePayment: pi.id });
    if (!existing && email) {
      const key       = generateLicenseKey();
      const expiresAt = getExpiryDate('annual');
      const now       = new Date().toISOString();
      await dbInsert(db.licenses, { key, email, name: name || '', plan: 'annual', price: 14, status: 'active', stripePayment: pi.id, activatedAt: now, expiresAt, devices: [], createdAt: now }).catch(() => {});
      await dbInsert(db.payments, { stripeId: pi.id, email, amount: pi.amount / 100, status: 'succeeded', licenseKey: key, createdAt: now }).catch(() => {});
      await sendActivationEmail(email, name, key);
      console.log(`✦ Webhook license issued: ${key} → ${email}`);
    }
  }
  res.json({ received: true });
});

// ─── ADMIN ROUTES ──────────────────────────────────────────────────────────
app.get('/admin/stats', adminAuth, async (req, res) => {
  const [totalLicenses, activeLicenses, expiredLicenses, totalUsers, totalPayments, recentLicenses, payments] = await Promise.all([
    dbCount(db.licenses),
    dbCount(db.licenses, { status: 'active' }),
    dbCount(db.licenses, { status: 'expired' }),
    dbCount(db.users),
    dbCount(db.payments, { status: 'succeeded' }),
    dbFind(db.licenses, {}),
    dbFind(db.payments, { status: 'succeeded' }),
  ]);
  const totalRevenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const sorted       = recentLicenses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
  res.json({ totalLicenses, activeLicenses, expiredLicenses, totalRevenue, totalUsers, totalPayments, recentLicenses: sorted });
});

app.get('/admin/licenses', adminAuth, async (req, res) => {
  const { search, status } = req.query;
  let licenses = await dbFind(db.licenses, status ? { status } : {});
  if (search) {
    const s = search.toLowerCase();
    licenses = licenses.filter(l => l.email?.toLowerCase().includes(s) || l.key?.toLowerCase().includes(s) || l.name?.toLowerCase().includes(s));
  }
  licenses.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ licenses, total: licenses.length });
});

app.post('/admin/generate-key', adminAuth, async (req, res) => {
  const { email, name, plan = 'annual' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const key       = generateLicenseKey();
  const expiresAt = getExpiryDate(plan);
  const now       = new Date().toISOString();
  await dbInsert(db.licenses, { key, email, name: name || '', plan, price: 0, status: 'active', stripePayment: null, activatedAt: now, expiresAt, devices: [], createdAt: now });
  await sendActivationEmail(email, name, key);
  res.json({ key, expiresAt, message: 'Key generated and emailed' });
});

app.post('/admin/revoke-key', adminAuth, async (req, res) => {
  await dbUpdate(db.licenses, { key: req.body.key }, { $set: { status: 'revoked' } });
  res.json({ message: 'License revoked' });
});

app.post('/admin/restore-key', adminAuth, async (req, res) => {
  await dbUpdate(db.licenses, { key: req.body.key }, { $set: { status: 'active' } });
  res.json({ message: 'License restored' });
});

app.get('/admin/payments', adminAuth, async (req, res) => {
  const payments = await dbFind(db.payments, {});
  payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ payments });
});

// ─── START ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║  ✦  SOL PLAYER SERVER RUNNING       ║
  ║     Port: ${PORT}                      ║
  ╚══════════════════════════════════════╝
  `);
});
