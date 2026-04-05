const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'hivecontrol-secret-change-me';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'hiveadmin2026!';

// ── Middleware ─────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ── Calculate expiry date ─────────────────────────────────────────
function calcExpiryDate(months, startDate = new Date()) {
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + months);
  return d;
}

const PLAN_MONTHS = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMI_ANNUAL: 6,
  ANNUAL: 12,
};

const PLAN_DEVICE_LIMITS = {
  MONTHLY: 10,
  QUARTERLY: 25,
  SEMI_ANNUAL: 50,
  ANNUAL: 100,
};

// ── Auth ───────────────────────────────────────────────────────────

// Register (public — for new clients)
app.post('/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashed, name, role: 'CLIENT' },
    });
    res.json({ ok: true, userId: user.id });
  } catch (e) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

// Login
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ── License Validation (called by HiveControl server on startup) ──

app.post('/license/validate', async (req, res) => {
  const { licenseKey, machineId, machineName, ip } = req.body;
  if (!licenseKey || !machineId) return res.status(400).json({ error: 'licenseKey and machineId required' });

  const license = await prisma.license.findUnique({
    where: { key: licenseKey },
    include: { user: true, activations: true },
  });

  if (!license) return res.status(404).json({ valid: false, error: 'License not found' });
  if (license.status === 'SUSPENDED') return res.status(403).json({ valid: false, error: 'License suspended' });
  if (license.status === 'CANCELLED') return res.status(403).json({ valid: false, error: 'License cancelled' });

  // Check expiry
  const now = new Date();
  if (now > license.expiresAt) {
    await prisma.license.update({ where: { id: license.id }, data: { status: 'EXPIRED' } });
    return res.json({
      valid: false,
      error: 'License expired',
      expiredAt: license.expiresAt,
    });
  }

  // Upsert activation
  const existing = license.activations.find(a => a.machineId === machineId);
  if (existing) {
    await prisma.activation.update({ where: { id: existing.id }, data: { lastSeen: now, ip: ip || existing.ip } });
  } else {
    await prisma.activation.create({
      data: { licenseId: license.id, machineId, machineName, ip },
    });
  }

  const daysLeft = Math.ceil((license.expiresAt - now) / (1000 * 60 * 60 * 24));

  res.json({
    valid: true,
    licenseId: license.id,
    plan: license.plan,
    deviceLimit: license.deviceLimit,
    expiresAt: license.expiresAt,
    daysLeft,
    user: { name: license.user.name, email: license.user.email },
  });
});

// ── Client routes ─────────────────────────────────────────────────

// Get my licenses
app.get('/licenses/my', authMiddleware, async (req, res) => {
  const licenses = await prisma.license.findMany({
    where: { userId: req.user.userId },
    include: { activations: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(licenses);
});

// ── Admin routes ──────────────────────────────────────────────────

// List all users
app.get('/admin/users', adminMiddleware, async (req, res) => {
  const users = await prisma.user.findMany({
    include: { licenses: { include: { activations: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(users);
});

// Create user
app.post('/admin/users', adminMiddleware, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, password: hashed, name } });
  res.json(user);
});

// Create license for user
app.post('/admin/licenses', adminMiddleware, async (req, res) => {
  const { userId, plan, months, deviceLimit, startDate } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const planMonths = months || PLAN_MONTHS[plan] || 1;
  const planDevices = deviceLimit || PLAN_DEVICE_LIMITS[plan] || 10;
  const start = startDate ? new Date(startDate) : new Date();
  const expiresAt = calcExpiryDate(planMonths, start);

  const license = await prisma.license.create({
    data: {
      userId,
      plan: plan || 'MONTHLY',
      months: planMonths,
      deviceLimit: planDevices,
      startDate: start,
      expiresAt,
      status: 'ACTIVE',
    },
    include: { user: true },
  });

  res.json({
    ...license,
    expiresAt,
    daysValid: planMonths * 30,
    message: `License valid for ${planMonths} month(s) — expires ${expiresAt.toLocaleDateString()}`,
  });
});

// Extend license
app.post('/admin/licenses/:id/extend', adminMiddleware, async (req, res) => {
  const { months } = req.body;
  if (!months) return res.status(400).json({ error: 'months required' });

  const license = await prisma.license.findUnique({ where: { id: req.params.id } });
  if (!license) return res.status(404).json({ error: 'Not found' });

  const base = license.expiresAt > new Date() ? license.expiresAt : new Date();
  const newExpiry = calcExpiryDate(months, base);

  const updated = await prisma.license.update({
    where: { id: req.params.id },
    data: { expiresAt: newExpiry, status: 'ACTIVE', months: license.months + months },
  });

  res.json({ ...updated, message: `Extended ${months} month(s) — now expires ${newExpiry.toLocaleDateString()}` });
});

// Suspend / cancel license
app.post('/admin/licenses/:id/suspend', adminMiddleware, async (req, res) => {
  const updated = await prisma.license.update({ where: { id: req.params.id }, data: { status: 'SUSPENDED' } });
  res.json(updated);
});

app.post('/admin/licenses/:id/cancel', adminMiddleware, async (req, res) => {
  const updated = await prisma.license.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
  res.json(updated);
});

// All licenses
app.get('/admin/licenses', adminMiddleware, async (req, res) => {
  const licenses = await prisma.license.findMany({
    include: { user: true, activations: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(licenses);
});

// Stats
app.get('/admin/stats', adminMiddleware, async (req, res) => {
  const [totalUsers, totalLicenses, activeLicenses, expiredLicenses] = await Promise.all([
    prisma.user.count(),
    prisma.license.count(),
    prisma.license.count({ where: { status: 'ACTIVE' } }),
    prisma.license.count({ where: { status: 'EXPIRED' } }),
  ]);
  res.json({ totalUsers, totalLicenses, activeLicenses, expiredLicenses });
});

// ── Bootstrap admin user ──────────────────────────────────────────
async function bootstrapAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@hivecontrol.app';
  const adminPass = process.env.ADMIN_PASSWORD || 'HiveAdmin2026!';
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    const hashed = await bcrypt.hash(adminPass, 10);
    await prisma.user.create({ data: { email: adminEmail, password: hashed, name: 'HiveControl Admin', role: 'ADMIN' } });
    console.log(`✅ Admin created: ${adminEmail}`);
  }
}

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'HiveControl License API' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🐝 HiveControl License API running on :${PORT}`);
  await bootstrapAdmin();
});
