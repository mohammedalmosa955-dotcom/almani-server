const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('[WS] متصل:', socket.id);
  socket.on('join', (role) => { socket.join(role); });
  socket.on('disconnect', () => { console.log('[WS] منقطع:', socket.id); });
});

// ============================================================
// PRODUCTS API
// ============================================================

app.get('/api/products', async (req, res) => {
  let query = supabase.from('products').select('*');
  if (req.query.active === 'true') query = query.eq('active', true);
  if (req.query.active === 'false') query = query.eq('active', false);
  if (req.query.cat) query = query.eq('cat', req.query.cat);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    query = query.or(`name.ilike.%${q}%,sub.ilike.%${q}%`);
  }
  const { data, error } = await query.order('id', { ascending: true });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

app.get('/api/products/:id', async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('id', parseInt(req.params.id)).single();
  if (error || !data) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
  res.json({ success: true, data });
});

app.post('/api/products', async (req, res) => {
  const { name, sub, price, cat, unit, badge, discount, image } = req.body;
  if (!name || !price || !cat) {
    return res.status(400).json({ success: false, error: 'الاسم والسعر والقسم مطلوب' });
  }
  const { data, error } = await supabase.from('products').insert([{
    name,
    sub: sub || '',
    price: parseFloat(price),
    cat,
    unit: unit || 'قطعة',
    badge: badge || '',
    discount: discount ? parseFloat(discount) : 0,
    active: true,
    image: image || ''
  }]).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  io.emit('products:updated', { action: 'create', product: data[0] });
  res.json({ success: true, data: data[0] });
});

app.put('/api/products/:id', async (req, res) => {
  const { name, sub, price, cat, unit, badge, active, discount, image } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (sub !== undefined) updates.sub = sub;
  if (price !== undefined) updates.price = parseFloat(price);
  if (cat !== undefined) updates.cat = cat;
  if (unit !== undefined) updates.unit = unit;
  if (badge !== undefined) updates.badge = badge;
  if (active !== undefined) updates.active = active === 'true' || active === true;
  if (discount !== undefined) updates.discount = parseFloat(discount);
  if (image !== undefined) updates.image = image;

  const { data, error } = await supabase.from('products').update(updates).eq('id', parseInt(req.params.id)).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data || !data.length) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
  io.emit('products:updated', { action: 'update', product: data[0] });
  res.json({ success: true, data: data[0] });
});

app.delete('/api/products/:id', async (req, res) => {
  const { data, error } = await supabase.from('products').delete().eq('id', parseInt(req.params.id)).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data || !data.length) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
  res.json({ success: true, data: data[0] });
});

app.patch('/api/products/:id/toggle', async (req, res) => {
  const { data: prod, error: fetchErr } = await supabase.from('products').select('active').eq('id', parseInt(req.params.id)).single();
  if (fetchErr || !prod) return res.status(404).json({ success: false, error: 'المنتج غير موجود' });
  const { data, error } = await supabase.from('products').update({ active: !prod.active }).eq('id', parseInt(req.params.id)).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data: { id: data[0].id, active: data[0].active } });
});

// ============================================================
// ORDERS API
// ============================================================

app.get('/api/orders', async (req, res) => {
  let query = supabase.from('orders').select('*');
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.phone) query = query.eq('phone', req.query.phone);
  if (req.query.limit) query = query.limit(parseInt(req.query.limit));
  const { data, error } = await query.order('date', { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

app.get('/api/orders/stats', async (req, res) => {
  const { data, error } = await supabase.from('orders').select('status');
  if (error) return res.status(500).json({ success: false, error: error.message });
  const stats = { total: 0, pending: 0, confirmed: 0, preparing: 0, delivering: 0, delivered: 0, cancelled: 0 };
  data.forEach(o => { stats.total++; if (stats[o.status] !== undefined) stats[o.status]++; });
  res.json({ success: true, data: stats });
});

app.post('/api/orders', async (req, res) => {
  const { items, total, address, lat, lng, phone, name, payment, txnId } = req.body;
  if (!items || !items.length) return res.status(400).json({ success: false, error: 'الطلب فارغ' });
  const order = {
    id: 'ORD-' + Date.now().toString(36).toUpperCase(),
    items,
    status: 'pending',
    date: new Date().toISOString(),
    total: parseFloat(total || 0),
    payment: payment || 'cash',
    txnId: txnId || '',
    address: address || '',
    lat: lat || null,
    lng: lng || null,
    phone: phone || '',
    name: name || ''
  };
  const { data, error } = await supabase.from('orders').insert([order]).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  io.emit('orders:updated', { action: 'create', order: data[0] });
  res.json({ success: true, data: data[0] });
});

app.put('/api/orders/:id/status', async (req, res) => {
  const validStatuses = ['pending', 'confirmed', 'preparing', 'delivering', 'delivered', 'cancelled'];
  if (!validStatuses.includes(req.body.status)) {
    return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
  }
  const { data, error } = await supabase.from('orders').update({ status: req.body.status }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data || !data.length) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
  io.emit('orders:updated', { action: 'update', order: data[0] });
  res.json({ success: true, data: data[0] });
});

app.delete('/api/orders/:id', async (req, res) => {
  const { data, error } = await supabase.from('orders').delete().eq('id', req.params.id).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data || !data.length) return res.status(404).json({ success: false, error: 'الطلب غير موجود' });
  res.json({ success: true, data: data[0] });
});

// ============================================================
// CATEGORIES API
// ============================================================

app.get('/api/categories', async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

app.post('/api/categories', async (req, res) => {
  const { id, name, icon, color } = req.body;
  if (!name) return res.status(400).json({ success: false, error: 'اسم القسم مطلوب' });
  const cat = { id: id || 'cat_' + Date.now(), name, icon: icon || 'fa-tag', color: color || '#16A34A' };
  const { data, error } = await supabase.from('categories').insert([cat]).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  io.emit('categories:updated', data);
  res.json({ success: true, data: data[0] });
});

app.put('/api/categories/:id', async (req, res) => {
  const { name, icon, color } = req.body;
  const updates = {};
  if (name) updates.name = name;
  if (icon) updates.icon = icon;
  if (color) updates.color = color;
  const { data, error } = await supabase.from('categories').update(updates).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data || !data.length) return res.status(404).json({ success: false, error: 'القسم غير موجود' });
  res.json({ success: true, data: data[0] });
});

app.delete('/api/categories/:id', async (req, res) => {
  const { data: linked } = await supabase.from('products').select('id').eq('cat', req.params.id).limit(1);
  if (linked && linked.length) {
    return res.status(400).json({ success: false, error: 'هناك منتجات مرتبطة بهذا القسم' });
  }
  const { data, error } = await supabase.from('categories').delete().eq('id', req.params.id).select();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data || !data.length) return res.status(404).json({ success: false, error: 'القسم غير موجود' });
  io.emit('categories:updated', data);
  res.json({ success: true, data: data[0] });
});

// ============================================================
// AUTH
// ============================================================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin-token-2024' });
  } else {
    res.status(401).json({ success: false, error: 'كلمة المرور خاطئة' });
  }
});

app.post('/api/auth/send-otp', (req, res) => {
  const { phone, code, apiKey } = req.body;
  if (!phone || !code) return res.status(400).json({ success: false, error: 'الرقم والرمز مطلوبان' });
  if (apiKey) {
    const fullPhone = phone.startsWith('963') ? phone : '963' + phone;
    const msg = encodeURIComponent('رمز التحقق الخاص بك في سوبر ماركت ألماني: ' + code);
    const url = 'https://api.callmebot.com/whatsapp.php?phone=' + fullPhone + '&text=' + msg + '&apikey=' + encodeURIComponent(apiKey);
    fetch(url).then(r => r.text()).then(t => {
      res.json({ success: t.trim() === 'OK', data: { sent: t.trim() === 'OK' } });
    }).catch(() => {
      res.json({ success: true, data: { sent: false } });
    });
  } else {
    res.json({ success: true, data: { sent: false } });
  }
});

// ============================================================
// SETTINGS API
// ============================================================

app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*');
  if (error) return res.status(500).json({ success: false, error: error.message });
  const settings = {};
  data.forEach(s => { settings[s.key] = s.value; });
  res.json({ success: true, data: settings });
});

app.put('/api/settings', async (req, res) => {
  const entries = Object.entries(req.body);
  for (const [key, value] of entries) {
    const { error } = await supabase.from('settings').upsert({ key, value }, { onConflict: 'key' });
    if (error) return res.status(500).json({ success: false, error: error.message });
  }
  io.emit('settings:updated', req.body);
  res.json({ success: true, data: req.body });
});

// ============================================================
// SEED DATA - استيراد البيانات الأولية
// ============================================================

app.post('/api/seed', async (req, res) => {
  const { products, categories, orders, settings } = req.body;
  try {
    if (categories && categories.length) {
      const { error } = await supabase.from('categories').upsert(categories, { onConflict: 'id' });
      if (error) return res.status(500).json({ success: false, error: error.message });
    }
    if (products && products.length) {
      const { error } = await supabase.from('products').upsert(products, { onConflict: 'id' });
      if (error) return res.status(500).json({ success: false, error: error.message });
    }
    if (orders && orders.length) {
      const { error } = await supabase.from('orders').upsert(orders, { onConflict: 'id' });
      if (error) return res.status(500).json({ success: false, error: error.message });
    }
    if (settings && settings.length) {
      const { error } = await supabase.from('settings').upsert(settings, { onConflict: 'key' });
      if (error) return res.status(500).json({ success: false, error: error.message });
    }
    res.json({ success: true, message: 'تم استيراد البيانات بنجاح' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// Error handling
// ============================================================

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, error: err.message || 'خطأ داخلي في السيرفر' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// Start server
// ============================================================

server.listen(PORT, '0.0.0.0', () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  سوبر ماركت ألماني - Online Server`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  السيرفر شغال على:`);
  console.log(`  → محلي:    http://localhost:${PORT}`);
  console.log(`  → الشبكة:  http://YOUR_IP:${PORT}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  التطبيق:      http://localhost:${PORT}/`);
  console.log(`  لوحة التحكم:  http://localhost:${PORT}/admin.html`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});
