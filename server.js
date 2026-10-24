require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const pool = require('./db');
pool.query('SELECT 1').then(() => console.log('Database connected')).catch(e => console.error('Database error:', e.message));
const mpesa = require('./mpesa');

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 10 },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */

const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Wraps async routes so errors become JSON responses
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error: ' + e.message });
  });

const auth = (req, res, next) =>
  req.session.user ? next() : res.status(401).json({ error: 'Please log in' });

const bossOnly = (req, res, next) =>
  req.session.user && req.session.user.role === 'boss'
    ? next()
    : res.status(403).json({ error: 'Only the boss can do this' });

async function audit(req, userId, action, details) {
  try {
    await pool.query(
      'INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
      [userId || null, action, details || null, req.ip]
    );
  } catch (e) {
    console.error('Audit failed:', e.message);
  }
}

// Checks the cart, finds prices and stock. lock=true locks rows (use inside a transaction)
async function priceItems(conn, items, lock) {
  if (!Array.isArray(items) || !items.length) throw httpErr(400, 'The cart is empty');
  const merged = new Map();
  for (const it of items) {
    const id = Number(it.product_id);
    const qty = parseInt(it.quantity, 10);
    if (!id || !(qty > 0)) throw httpErr(400, 'Invalid item in cart');
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  let total = 0;
  const lines = [];
  for (const [id, qty] of [...merged.entries()].sort((a, b) => a[0] - b[0])) {
    const [rows] = await conn.query(
      `SELECT * FROM products WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
      [id]
    );
    const p = rows[0];
    if (!p) throw httpErr(400, 'A product in the cart no longer exists');
    if (p.quantity < qty) throw httpErr(400, `Not enough stock for ${p.name} (only ${p.quantity} left)`);
    total += Number(p.selling_price) * qty;
    lines.push({ p, qty });
  }
  return { lines, total };
}

function toCsv(rows) {
  if (!rows.length) return 'No data\n';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

/* ---------- login ---------- */

app.post('/api/login', h(async (req, res) => {
  const { username, password, role } = req.body;
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username || '']);
  const u = rows[0];
  const ok = u && (await bcrypt.compare(password || '', u.password_hash)) && (!role || u.role === role);
  if (!ok) {
    await audit(req, u ? u.id : null, 'login_failed', `username: ${username}`);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  req.session.user = { id: u.id, username: u.username, role: u.role };
  await audit(req, u.id, 'login');
  res.json(req.session.user);
}));

app.post('/api/logout', auth, h(async (req, res) => {
  await audit(req, req.session.user.id, 'logout');
  req.session.destroy(() => res.json({ ok: true }));
}));

app.get('/api/me', auth, (req, res) => res.json(req.session.user));

/* ---------- products and stock ---------- */

app.get('/api/types', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT id, name FROM product_types ORDER BY name');
  res.json(rows);
}));

app.get('/api/products', auth, h(async (req, res) => {
  const boss = req.session.user.role === 'boss';
  const cols = boss
    ? 'p.id, p.name, t.name AS type, p.buying_price, p.selling_price, p.quantity'
    : 'p.id, p.name, t.name AS type, p.selling_price, p.quantity';
  const [rows] = await pool.query(
    `SELECT ${cols} FROM products p JOIN product_types t ON t.id = p.type_id ORDER BY p.name`
  );
  res.json(rows);
}));

app.post('/api/products', auth, h(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const typeName = String(req.body.type || '').trim();
  const buying = Number(req.body.buying_price);
  const selling = Number(req.body.selling_price);
  const qty = parseInt(req.body.quantity || 0, 10);
  if (!name || !typeName) throw httpErr(400, 'Enter the product name and type');
  if (!(buying >= 0) || !(selling >= 0) || !(qty >= 0)) throw httpErr(400, 'Check the prices and quantity');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('INSERT IGNORE INTO product_types (name) VALUES (?)', [typeName]);
    const [[type]] = await conn.query('SELECT id FROM product_types WHERE name = ?', [typeName]);
    const [r] = await conn.query(
      'INSERT INTO products (name, type_id, buying_price, selling_price, quantity) VALUES (?, ?, ?, ?, ?)',
      [name, type.id, buying, selling, qty]
    );
    if (qty > 0) {
      await conn.query(
        'INSERT INTO stock_entries (product_id, quantity, buying_price, added_by) VALUES (?, ?, ?, ?)',
        [r.insertId, qty, buying, req.session.user.id]
      );
    }
    await conn.commit();
    await audit(req, req.session.user.id, 'product_created', `${name} (${typeName}), qty ${qty}`);
    res.json({ id: r.insertId });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

app.post('/api/products/:id/stock', auth, h(async (req, res) => {
  const qty = parseInt(req.body.quantity, 10);
  if (!(qty > 0)) throw httpErr(400, 'Enter a quantity greater than 0');
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  const p = rows[0];
  if (!p) throw httpErr(404, 'Product not found');
  const buying =
    req.body.buying_price !== undefined && req.body.buying_price !== ''
      ? Number(req.body.buying_price)
      : Number(p.buying_price);
  if (!(buying >= 0)) throw httpErr(400, 'Check the buying price');

  await pool.query('UPDATE products SET quantity = quantity + ?, buying_price = ? WHERE id = ?', [qty, buying, p.id]);
  await pool.query(
    'INSERT INTO stock_entries (product_id, quantity, buying_price, added_by) VALUES (?, ?, ?, ?)',
    [p.id, qty, buying, req.session.user.id]
  );
  await audit(req, req.session.user.id, 'stock_added', `${p.name}: +${qty} at buying price ${buying}`);
  res.json({ ok: true });
}));

app.put('/api/products/:id', auth, bossOnly, h(async (req, res) => {
  const buying = Number(req.body.buying_price);
  const selling = Number(req.body.selling_price);
  if (!(buying >= 0) || !(selling >= 0)) throw httpErr(400, 'Check the prices');
  const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
  const p = rows[0];
  if (!p) throw httpErr(404, 'Product not found');
  await pool.query('UPDATE products SET buying_price = ?, selling_price = ? WHERE id = ?', [buying, selling, p.id]);
  await audit(
    req, req.session.user.id, 'price_changed',
    `${p.name}: buying ${p.buying_price} -> ${buying}, selling ${p.selling_price} -> ${selling}`
  );
  res.json({ ok: true });
}));

/* ---------- M-Pesa ---------- */

app.post('/api/mpesa/stkpush', auth, h(async (req, res) => {
  const phone = mpesa.formatPhone(req.body.phone);
  if (!phone) throw httpErr(400, 'Enter a valid Safaricom number, for example 0712345678');
  const { total } = await priceItems(pool, req.body.items, false);
  const amount = Math.ceil(total);

  const data = await mpesa.stkPush(phone, amount, 'LIQUOR');
  if (data.ResponseCode !== '0') {
    throw httpErr(502, data.errorMessage || data.ResponseDescription || 'M-Pesa request failed');
  }
  await pool.query(
    'INSERT INTO mpesa_payments (phone_number, amount, merchant_request_id, checkout_request_id) VALUES (?, ?, ?, ?)',
    [phone, amount, data.MerchantRequestID, data.CheckoutRequestID]
  );
  await audit(req, req.session.user.id, 'mpesa_prompt_sent', `${phone}, KES ${amount}`);
  res.json({ checkout_request_id: data.CheckoutRequestID });
}));

// Safaricom calls this after the buyer enters (or cancels) the PIN. No login needed.
app.post('/api/mpesa/callback', async (req, res) => {
  console.log('CALLBACK RECEIVED:', JSON.stringify(req.body));
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const cb = req.body && req.body.Body && req.body.Body.stkCallback;
    if (cb) {
      const status = cb.ResultCode === 0 ? 'success' : cb.ResultCode === 1032 ? 'cancelled' : 'failed';
      const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
      const receipt = (items.find((i) => i.Name === 'MpesaReceiptNumber') || {}).Value || null;
      await pool.query(
        'UPDATE mpesa_payments SET status = ?, result_desc = ?, mpesa_receipt_number = ? WHERE checkout_request_id = ?',
        [status, cb.ResultDesc, receipt, cb.CheckoutRequestID]
      );
    }
  } catch (e) {
    console.error('Callback error:', e.message);
  }
});

app.get('/api/mpesa/status/:id', auth, h(async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM mpesa_payments WHERE checkout_request_id = ?', [req.params.id]);
  const p = rows[0];
  if (!p) throw httpErr(404, 'Payment not found');
  if (p.status === 'pending') {
    try {
      const q = await mpesa.stkQuery(p.checkout_request_id);
      if (q.ResultCode !== undefined) {
        const code = Number(q.ResultCode);
        const status = code === 0 ? 'success' : code === 1032 ? 'cancelled' : 'failed';
        await pool.query(
          "UPDATE mpesa_payments SET status = ?, result_desc = ? WHERE checkout_request_id = ? AND status = 'pending'",
          [status, q.ResultDesc, p.checkout_request_id]
        );
        p.status = status;
        p.result_desc = q.ResultDesc;
      }
    } catch (e) {
      /* still processing: keep waiting */
    }
  }
  res.json({ status: p.status, result_desc: p.result_desc });
}));

/* ---------- sales ---------- */

app.post('/api/sales', auth, h(async (req, res) => {
  const method = req.body.payment_method === 'mpesa' ? 'mpesa' : 'cash';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { lines, total } = await priceItems(conn, req.body.items, true);

    let pay = null;
    if (method === 'mpesa') {
      const [pr] = await conn.query(
        'SELECT * FROM mpesa_payments WHERE checkout_request_id = ? FOR UPDATE',
        [req.body.mpesa_checkout_id || '']
      );
      pay = pr[0];
      if (!pay || pay.status !== 'success' || pay.sale_id) throw httpErr(400, 'The M-Pesa payment is not confirmed');
      if (Number(pay.amount) !== Math.ceil(total)) throw httpErr(400, 'The amount paid does not match the cart total');
    }

    const receiptNo =
      'R' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 36).toString(36).toUpperCase();
    const [r] = await conn.query(
      'INSERT INTO sales (receipt_no, cashier_id, total_amount, payment_method) VALUES (?, ?, ?, ?)',
      [receiptNo, req.session.user.id, total, method]
    );
    const saleId = r.insertId;
    for (const { p, qty } of lines) {
      await conn.query(
        'INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost) VALUES (?, ?, ?, ?, ?)',
        [saleId, p.id, qty, p.selling_price, p.buying_price]
      );
      await conn.query('UPDATE products SET quantity = quantity - ? WHERE id = ?', [qty, p.id]);
    }
    if (pay) await conn.query('UPDATE mpesa_payments SET sale_id = ? WHERE id = ?', [saleId, pay.id]);

    await conn.commit();
    await audit(req, req.session.user.id, 'sale_created', `${receiptNo}, KES ${total}, ${method}`);
    res.json({ sale_id: saleId, receipt_no: receiptNo });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

app.get('/api/sales', auth, h(async (req, res) => {
  const boss = req.session.user.role === 'boss';
  const profit = boss
    ? ', (SELECT SUM((si.unit_price - si.unit_cost) * si.quantity) FROM sale_items si WHERE si.sale_id = s.id) AS profit'
    : '';
  const where = boss ? '' : 'WHERE s.cashier_id = ? AND DATE(s.created_at) = CURDATE()';
  const [rows] = await pool.query(
    `SELECT s.id, s.receipt_no, s.total_amount, s.payment_method, s.created_at, u.username AS cashier ${profit}
     FROM sales s JOIN users u ON u.id = s.cashier_id ${where}
     ORDER BY s.id DESC LIMIT 300`,
    boss ? [] : [req.session.user.id]
  );
  res.json(rows);
}));

app.get('/api/sales/:id', auth, h(async (req, res) => {
  const [sales] = await pool.query(
    `SELECT s.*, u.username AS cashier FROM sales s JOIN users u ON u.id = s.cashier_id WHERE s.id = ?`,
    [req.params.id]
  );
  if (!sales[0]) throw httpErr(404, 'Sale not found');
  const [items] = await pool.query(
    `SELECT p.name, si.quantity, si.unit_price FROM sale_items si
     JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?`,
    [req.params.id]
  );
  const [pay] = await pool.query(
    'SELECT phone_number, mpesa_receipt_number FROM mpesa_payments WHERE sale_id = ?',
    [req.params.id]
  );
  res.json({ ...sales[0], items, mpesa: pay[0] || null });
}));

/* ---------- boss: audit and exports ---------- */

app.get('/api/audit', auth, bossOnly, h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.created_at, COALESCE(u.username, 'unknown') AS user, a.action, a.details, a.ip_address
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`
  );
  res.json(rows);
}));

const exportQueries = {
  products: `SELECT p.id, p.name, t.name AS type, p.buying_price, p.selling_price, p.quantity
             FROM products p JOIN product_types t ON t.id = p.type_id ORDER BY p.name`,
  sales: `SELECT s.id, s.receipt_no, s.created_at, u.username AS cashier, s.payment_method, s.total_amount
          FROM sales s JOIN users u ON u.id = s.cashier_id ORDER BY s.id`,
  sale_items: `SELECT s.receipt_no, p.name AS product, si.quantity, si.unit_price, si.unit_cost
               FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
               ORDER BY si.id`,
  stock_entries: `SELECT e.id, e.added_at, p.name AS product, e.quantity, e.buying_price, u.username AS added_by
                  FROM stock_entries e JOIN products p ON p.id = e.product_id JOIN users u ON u.id = e.added_by
                  ORDER BY e.id`,
  mpesa: `SELECT id, created_at, phone_number, amount, status, mpesa_receipt_number, sale_id FROM mpesa_payments ORDER BY id`,
  audit: `SELECT a.id, a.created_at, COALESCE(u.username, 'unknown') AS user, a.action, a.details, a.ip_address
          FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id`,
};

app.get('/api/export/:name', auth, bossOnly, h(async (req, res) => {
  const sql = exportQueries[req.params.name];
  if (!sql) throw httpErr(404, 'Unknown export');
  const [rows] = await pool.query(sql);
  await audit(req, req.session.user.id, 'export', req.params.name);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}.csv"`);
  res.send('\uFEFF' + toCsv(rows)); // BOM so Excel reads it correctly
}));

/* ---------- start ---------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Liquor POS running at http://localhost:${PORT}`));
