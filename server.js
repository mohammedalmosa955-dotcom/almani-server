const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean);
const DB_FILE = path.join(__dirname, 'data', 'db.json');

console.log('Using local db.json');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { products: [], orders: [], categories: [], settings: {} }; }
}
function writeDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }

// Security
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { success: false, error: 'طلبات كثيرة جداً' } }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { success: false, error: 'محاولات كثيرة' } }));
app.use('/api/orders', rateLimit({ windowMs: 60 * 60 * 1000, max: 50, message: { success: false, error: 'طلبات كثيرة' } }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : '*', methods: ['GET', 'POST'] }
});
io.on('connection', (socket) => {
  console.log('[WS] متصل:', socket.id);
  socket.on('join', (role) => { socket.join(role); });
  socket.on('disconnect', () => { console.log('[WS] منقطع:', socket.id); });
});

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return validator.stripLow(str.trim()).slice(0, 500);
}
function validateId(id) {
  const n = parseInt(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function adminAuth(req, res, next) {
  if (req.headers.authorization === 'Bearer admin-token-2024') return next();
  res.status(401).json({ success: false, error: 'غير مصرح' });
}

// JSON helpers
function jGet(t) { const d = readDB(); return d[t] || []; }
function jOne(t, f, v) { return jGet(t).find(r => r[f] === v) || null; }
function jAdd(t, item) { const d = readDB(); if (!d[t]) d[t] = []; d[t].push(item); writeDB(d); return item; }
function jUpd(t, f, v, u) { const d = readDB(); const i = (d[t]||[]).findIndex(r => r[f] === v); if (i===-1) return null; Object.assign(d[t][i], u); writeDB(d); return d[t][i]; }
function jDel(t, f, v) { const d = readDB(); const i = (d[t]||[]).findIndex(r => r[f] === v); if (i===-1) return null; const r = d[t].splice(i,1)[0]; writeDB(d); return r; }


// ============================================================
// PRODUCTS
// ============================================================
app.get('/api/products', (req, res) => {
  try {
    let result = jGet('products');
    if (req.query.active === 'true') result = result.filter(p => p.active);
    if (req.query.active === 'false') result = result.filter(p => !p.active);
    if (req.query.cat) result = result.filter(p => p.cat === sanitize(req.query.cat));
    if (req.query.search) { const s = sanitize(req.query.search.toLowerCase()); result = result.filter(p => p.name.toLowerCase().includes(s) || (p.sub||'').toLowerCase().includes(s)); }
    res.json({ success: true, data: result || [] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/products/:id', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'معرف غير صالح' });
    const result = jOne('products', 'id', id);
    if (!result) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    res.json({ success: true, data: result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

function makeProduct(body) {
  return {
    name: sanitize(body.name),
    sub: sanitize(body.sub || ''),
    price: Math.min(Math.max(parseFloat(body.price) || 0, 1), 999999999),
    cat: sanitize(body.cat),
    unit: sanitize(body.unit || 'قطعة'),
    badge: sanitize(body.badge || ''),
    discount: Math.min(Math.max(parseFloat(body.discount) || 0, 0), 99),
    active: true,
    image: typeof body.image === 'string' ? body.image.slice(0, 5000) : ''
  };
}

app.post('/api/products', adminAuth, (req, res) => {
  try {
    const name = sanitize(req.body.name);
    const price = parseFloat(req.body.price);
    const cat = sanitize(req.body.cat);
    if (!name || name.length < 2) return res.status(400).json({ success: false, error: 'الاسم يجب أن يكون 2 أحرف على الأقل' });
    if (!price || price < 1) return res.status(400).json({ success: false, error: 'سعر غير صالح' });
    if (!cat) return res.status(400).json({ success: false, error: 'القسم مطلوب' });
    const prod = makeProduct(req.body);
    prod.id = Date.now();
    const p = jAdd('products', prod);
    io.emit('products:updated', { action: 'create', product: p });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/products/:id', adminAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'معرف غير صالح' });
    const u = {};
    if (req.body.name !== undefined) u.name = sanitize(req.body.name);
    if (req.body.sub !== undefined) u.sub = sanitize(req.body.sub);
    if (req.body.price !== undefined) u.price = Math.min(Math.max(parseFloat(req.body.price) || 0, 1), 999999999);
    if (req.body.cat !== undefined) u.cat = sanitize(req.body.cat);
    if (req.body.unit !== undefined) u.unit = sanitize(req.body.unit);
    if (req.body.badge !== undefined) u.badge = sanitize(req.body.badge);
    if (req.body.active !== undefined) u.active = req.body.active === 'true' || req.body.active === true;
    if (req.body.discount !== undefined) u.discount = Math.min(Math.max(parseFloat(req.body.discount) || 0, 0), 99);
    if (req.body.image !== undefined) u.image = typeof req.body.image === 'string' ? req.body.image.slice(0, 5000) : '';
    const p = jUpd('products', 'id', id, u);
    if (!p) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    io.emit('products:updated', { action: 'update', product: p });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/products/:id', adminAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'معرف غير صالح' });
    const p = jDel('products', 'id', id);
    if (!p) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/products/:id/toggle', adminAuth, (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'معرف غير صالح' });
    const p = jOne('products', 'id', id);
    if (!p) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
    const u = jUpd('products', 'id', id, { active: !p.active });
    res.json({ success: true, data: { id: u.id, active: u.active } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// ORDERS
// ============================================================
app.get('/api/orders', adminAuth, (req, res) => {
  try {
    let result = jGet('orders');
    if (req.query.status) result = result.filter(o => o.status === sanitize(req.query.status));
    if (req.query.phone) result = result.filter(o => o.phone === sanitize(req.query.phone));
    result.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ success: true, data: result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/orders/stats', adminAuth, (req, res) => {
  try {
    const items = jGet('orders');
    const s = { total: 0, pending: 0, confirmed: 0, preparing: 0, delivering: 0, delivered: 0, cancelled: 0 };
    items.forEach(o => { s.total++; if (s[o.status] !== undefined) s[o.status]++; });
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/orders', (req, res) => {
  try {
    const { items, total, address, lat, lng, phone, name, payment, txnId } = req.body;
    if (!items || !items.length) return res.status(400).json({ success: false, error: 'الطلب فارغ' });
    if (items.length > 100) return res.status(400).json({ success: false, error: 'عدد المنتجات كبير جداً' });
    const phoneClean = sanitize(String(phone || '')).replace(/\D/g, '').slice(0, 15);
    if (!phoneClean) return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
    const order = {
      id: 'ORD-' + Date.now().toString(36).toUpperCase(),
      items: items.slice(0, 100).map(i => ({ name: sanitize(i.name), sub: sanitize(i.sub) || '', qty: Math.min(Math.max(parseInt(i.qty) || 1, 1), 999), price: Math.min(Math.max(parseFloat(i.price) || 0, 0), 999999999), unit: sanitize(i.unit) || '' })),
      status: 'pending', date: new Date().toISOString(),
      total: Math.min(Math.max(parseFloat(total || 0), 0), 999999999),
      payment: ['cash','syriatel','sham','qr'].includes(payment) ? payment : 'cash',
      txnId: sanitize(txnId || '').slice(0, 50), address: sanitize(address || '').slice(0, 500),
      lat: lat !== undefined ? parseFloat(lat) : null, lng: lng !== undefined ? parseFloat(lng) : null,
      phone: phoneClean, name: sanitize(name || '').slice(0, 100)
    };
    const o = jAdd('orders', order);
    io.emit('orders:updated', { action: 'create', order: o });
    res.json({ success: true, data: o });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/orders/:id/status', adminAuth, (req, res) => {
  try {
    const validStatuses = ['pending', 'confirmed', 'preparing', 'delivering', 'delivered', 'cancelled'];
    const status = sanitize(req.body.status || '');
    if (!validStatuses.includes(status)) return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
    const o = jUpd('orders', 'id', sanitize(req.params.id), { status });
    if (!o) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
    io.emit('orders:updated', { action: 'update', order: o });
    res.json({ success: true, data: o });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/orders/:id', adminAuth, (req, res) => {
  try {
    const o = jDel('orders', 'id', sanitize(req.params.id));
    if (!o) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
    res.json({ success: true, data: o });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// CATEGORIES
// ============================================================
app.get('/api/categories', (req, res) => {
  try { res.json({ success: true, data: jGet('categories') }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/categories', adminAuth, (req, res) => {
  try {
    const name = sanitize(req.body.name);
    if (!name) return res.status(400).json({ success: false, error: 'اسم القسم مطلوب' });
    const cat = { id: 'cat_' + Date.now(), name, icon: sanitize(req.body.icon || 'fa-tag'), color: sanitize(req.body.color || '#16A34A') };
    const c = jAdd('categories', cat);
    io.emit('categories:updated', [c]);
    res.json({ success: true, data: c });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/categories/:id', adminAuth, (req, res) => {
  try {
    const u = {};
    if (req.body.name) u.name = sanitize(req.body.name);
    if (req.body.icon) u.icon = sanitize(req.body.icon);
    if (req.body.color) u.color = sanitize(req.body.color);
    const c = jUpd('categories', 'id', sanitize(req.params.id), u);
    if (!c) return res.status(404).json({ success: false, error: 'القسم غير موجود' });
    res.json({ success: true, data: c });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/categories/:id', adminAuth, (req, res) => {
  try {
    const catId = sanitize(req.params.id);
    const linked = jGet('products').filter(p => p.cat === catId);
    if (linked.length) return res.status(400).json({ success: false, error: 'هناك منتجات مرتبطة بهذا القسم' });
    const c = jDel('categories', 'id', catId);
    if (!c) return res.status(404).json({ success: false, error: 'القسم غير موجود' });
    io.emit('categories:updated', [c]);
    res.json({ success: true, data: c });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// AUTH
// ============================================================
app.post('/api/auth/login', (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length > 100) return res.status(400).json({ success: false, error: 'كلمة المرور طويلة جداً' });
  if (pw === ADMIN_PASSWORD) return res.json({ success: true, token: 'admin-token-2024' });
  res.status(401).json({ success: false, error: 'كلمة المرور خاطئة' });
});

app.post('/api/auth/send-otp', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '').slice(0, 15);
  const code = String(req.body.code || '').replace(/\D/g, '').slice(0, 6);
  if (!phone || !code) return res.status(400).json({ success: false, error: 'الرقم والرمز مطلوبان' });
  const apiKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim().slice(0, 200) : '';
  if (apiKey) {
    const fullPhone = phone.startsWith('963') ? phone : '963' + phone;
    const msg = encodeURIComponent('رمز التحقق الخاص بك في سوبر ماركت ألماني: ' + code);
    fetch(`https://api.callmebot.com/whatsapp.php?phone=${fullPhone}&text=${msg}&apikey=${encodeURIComponent(apiKey)}`)
      .then(r => r.text()).then(t => res.json({ success: t.trim() === 'OK', data: { sent: t.trim() === 'OK' } }))
      .catch(() => res.json({ success: true, data: { sent: false } }));
  } else res.json({ success: true, data: { sent: false } });
});

// ============================================================
// SETTINGS
// ============================================================
app.get('/api/settings', (req, res) => {
  try { res.json({ success: true, data: jGet('settings') }); } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/api/settings', adminAuth, (req, res) => {
  try {
    const validKeys = ['callMeBotKey', 'deliveryFee'];
    const d = readDB(); d.settings = d.settings || {};
    Object.entries(req.body).filter(([k]) => validKeys.includes(k)).forEach(([k, v]) => { d.settings[k] = String(v || '').slice(0, 500); });
    writeDB(d);
    io.emit('settings:updated', req.body);
    res.json({ success: true, data: req.body });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// SEED
// ============================================================
app.post('/api/seed', adminAuth, (req, res) => {
  try {
    const { products, categories, orders, settings } = req.body;
    const d = { products: products || [], categories: categories || [], orders: orders || [], settings: {}, users: [] };
    if (settings) settings.forEach(s => d.settings[s.key] = s.value);
    writeDB(d);
    res.json({ success: true, message: 'تم استيراد البيانات بنجاح' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ success: false, error: 'خطأ داخلي في السيرفر' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
server.listen(PORT, '0.0.0.0', () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  سوبر ماركت ألماني - Online Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Mode: Local JSON`);
  console.log(`  شغال على: http://0.0.0.0:${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
