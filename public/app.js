const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let user = null;
let products = [];
let cart = []; // [{ id, name, price, qty, max }]

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = '/index.html';
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setMsg(el, text, isError) {
  el.textContent = text || '';
  el.className = 'msg' + (isError ? ' error' : '');
}

/* ---------- start up ---------- */

(async function init() {
  user = await api('/api/me');
  $('#who').textContent = `${user.username} (${user.role})`;
  if (user.role === 'boss') document.querySelectorAll('.boss-only').forEach((b) => (b.hidden = false));
  await Promise.all([loadProducts(), loadTypes()]);
})();

$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/index.html';
};

/* ---------- tabs ---------- */

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab));
  if (btn.dataset.tab === 'sales') loadSales();
  if (btn.dataset.tab === 'audit') loadAudit();
  if (btn.dataset.tab === 'stock') loadProducts();
});

/* ---------- products ---------- */

async function loadProducts() {
  products = await api('/api/products');
  renderPicker();
  renderStock();
}

async function loadTypes() {
  const types = await api('/api/types');
  $('#typeList').innerHTML = types.map((t) => `<option value="${esc(t.name)}">`).join('');
}

function renderPicker() {
  const q = $('#search').value.trim().toLowerCase();
  const list = products.filter((p) => (p.name + ' ' + p.type).toLowerCase().includes(q));
  $('#picker').innerHTML = list.length
    ? list
        .map(
          (p) => `<button class="pick" data-id="${p.id}" ${p.quantity < 1 ? 'disabled' : ''}>
            <b>${esc(p.name)}</b>
            <span>${esc(p.type)}</span><br>
            <span>${money(p.selling_price)}</span><br>
            <span class="${p.quantity <= 5 ? 'low' : ''}">${p.quantity < 1 ? 'Out of stock' : p.quantity + ' in stock'}</span>
          </button>`
        )
        .join('')
    : '<p class="empty">No products found.</p>';
}
$('#search').oninput = renderPicker;

$('#picker').addEventListener('click', (e) => {
  const btn = e.target.closest('.pick');
  if (!btn) return;
  const p = products.find((x) => x.id === Number(btn.dataset.id));
  const line = cart.find((c) => c.id === p.id);
  if (line) {
    if (line.qty < p.quantity) line.qty++;
  } else {
    cart.push({ id: p.id, name: p.name, price: Number(p.selling_price), qty: 1, max: p.quantity });
  }
  renderCart();
});

/* ---------- cart and checkout ---------- */

const cartTotal = () => cart.reduce((s, c) => s + c.price * c.qty, 0);

function renderCart() {
  $('#cart').innerHTML = cart
    .map(
      (c, i) => `<tr>
        <td>${esc(c.name)}<br><span class="muted">${money(c.price)} each</span></td>
        <td><input type="number" min="1" max="${c.max}" value="${c.qty}" data-i="${i}" aria-label="Quantity"></td>
        <td class="num">${money(c.price * c.qty)}</td>
        <td><button class="btn light small" data-remove="${i}" aria-label="Remove">Remove</button></td>
      </tr>`
    )
    .join('');
  $('#cartEmpty').hidden = cart.length > 0;
  $('#total').textContent = money(cartTotal());
}

$('#cart').addEventListener('change', (e) => {
  const i = e.target.dataset.i;
  if (i === undefined) return;
  let q = parseInt(e.target.value, 10);
  if (!(q > 0)) q = 1;
  cart[i].qty = Math.min(q, cart[i].max);
  renderCart();
});
$('#cart').addEventListener('click', (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  cart.splice(Number(i), 1);
  renderCart();
});

document.querySelectorAll('input[name=pay]').forEach((r) =>
  r.addEventListener('change', () => {
    $('#phoneBox').hidden = document.querySelector('input[name=pay]:checked').value !== 'mpesa';
  })
);

$('#completeBtn').onclick = async () => {
  const btn = $('#completeBtn');
  const msg = $('#sellMsg');
  if (!cart.length) return setMsg(msg, 'Add at least one product first.', true);
  btn.disabled = true;
  try {
    const method = document.querySelector('input[name=pay]:checked').value;
    const items = cart.map((c) => ({ product_id: c.id, quantity: c.qty }));
    const body = { items, payment_method: method };

    if (method === 'mpesa') {
      const phone = $('#phone').value.trim();
      if (!phone) throw new Error('Enter the buyer\'s phone number.');
      setMsg(msg, 'Sending the M-Pesa prompt. Ask the buyer to enter their PIN...');
      const p = await api('/api/mpesa/stkpush', { method: 'POST', body: { phone, items } });

      let paid = false;
      for (let i = 0; i < 30; i++) {
        await sleep(3000);
        const s = await api('/api/mpesa/status/' + encodeURIComponent(p.checkout_request_id));
        if (s.status === 'success') { paid = true; break; }
        if (s.status === 'failed' || s.status === 'cancelled') {
          throw new Error('Payment ' + s.status + (s.result_desc ? ': ' + s.result_desc : ''));
        }
      }
      if (!paid) throw new Error('No payment received after 90 seconds. Try again.');
      body.mpesa_checkout_id = p.checkout_request_id;
    }

    const sale = await api('/api/sales', { method: 'POST', body });
    cart = [];
    renderCart();
    $('#phone').value = '';
    setMsg(msg, 'Sale recorded.');
    await loadProducts();
    showReceipt(sale.sale_id);
  } catch (e) {
    setMsg(msg, e.message, true);
  } finally {
    btn.disabled = false;
  }
};

/* ---------- receipt ---------- */

async function showReceipt(id) {
  const s = await api('/api/sales/' + id);
  const lines = s.items
    .map(
      (i) => `<div>${esc(i.name)}</div>
      <div class="row"><span>${i.quantity} x ${Number(i.unit_price).toFixed(2)}</span><span>${(i.quantity * i.unit_price).toFixed(2)}</span></div>`
    )
    .join('');
  $('#receipt').innerHTML = `
    <h3>CLUB LIQUOR SHOP</h3>
    <div class="c">Receipt ${esc(s.receipt_no)}</div>
    <div class="c">${esc(s.created_at)}</div>
    <hr>
    ${lines}
    <hr>
    <div class="row"><b>TOTAL</b><b>${money(s.total_amount)}</b></div>
    <div class="row"><span>Paid by</span><span>${s.payment_method === 'mpesa' ? 'M-Pesa' : 'Cash'}</span></div>
    ${s.mpesa && s.mpesa.mpesa_receipt_number ? `<div class="row"><span>M-Pesa ref</span><span>${esc(s.mpesa.mpesa_receipt_number)}</span></div>` : ''}
    <div class="row"><span>Served by</span><span>${esc(s.cashier)}</span></div>
    <hr>
    <div class="c">Thank you. Drink responsibly.</div>`;
  $('#receiptModal').classList.add('show');
}
$('#printBtn').onclick = () => window.print();
$('#closeReceipt').onclick = () => $('#receiptModal').classList.remove('show');

/* ---------- stock tab ---------- */

function renderStock() {
  const boss = user && user.role === 'boss';
  $('#stockHead').innerHTML =
    '<tr><th>Product</th><th>Type</th>' +
    (boss ? '<th class="num">Buying</th>' : '') +
    '<th class="num">Selling</th><th class="num">In stock</th>' +
    (boss ? '<th></th>' : '') +
    '</tr>';
  $('#stockBody').innerHTML = products
    .map(
      (p) => `<tr>
        <td>${esc(p.name)}</td><td>${esc(p.type)}</td>
        ${boss ? `<td class="num">${Number(p.buying_price).toFixed(2)}</td>` : ''}
        <td class="num">${Number(p.selling_price).toFixed(2)}</td>
        <td class="num ${p.quantity <= 5 ? 'low' : ''}">${p.quantity}</td>
        ${boss ? `<td><button class="btn light small" data-edit="${p.id}">Edit prices</button></td>` : ''}
      </tr>`
    )
    .join('');
  $('#stockProduct').innerHTML = products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

$('#stockBody').addEventListener('click', async (e) => {
  const id = e.target.dataset.edit;
  if (!id) return;
  const p = products.find((x) => x.id === Number(id));
  const buying = prompt(`Buying price for ${p.name}:`, p.buying_price);
  if (buying === null) return;
  const selling = prompt(`Selling price for ${p.name}:`, p.selling_price);
  if (selling === null) return;
  try {
    await api('/api/products/' + id, { method: 'PUT', body: { buying_price: buying, selling_price: selling } });
    await loadProducts();
  } catch (err) {
    alert(err.message);
  }
});

$('#addStockBtn').onclick = async () => {
  const msg = $('#stockMsg');
  try {
    const id = $('#stockProduct').value;
    if (!id) throw new Error('Choose a product.');
    await api(`/api/products/${id}/stock`, {
      method: 'POST',
      body: { quantity: $('#stockQty').value, buying_price: $('#stockBuy').value },
    });
    $('#stockQty').value = '';
    $('#stockBuy').value = '';
    setMsg(msg, 'Stock added.');
    await loadProducts();
  } catch (e) {
    setMsg(msg, e.message, true);
  }
};

$('#addProductBtn').onclick = async () => {
  const msg = $('#newMsg');
  try {
    await api('/api/products', {
      method: 'POST',
      body: {
        name: $('#newName').value,
        type: $('#newType').value,
        buying_price: $('#newBuy').value,
        selling_price: $('#newSell').value,
        quantity: $('#newQty').value || 0,
      },
    });
    ['#newName', '#newType', '#newBuy', '#newSell', '#newQty'].forEach((s) => ($(s).value = ''));
    setMsg(msg, 'Product saved.');
    await Promise.all([loadProducts(), loadTypes()]);
  } catch (e) {
    setMsg(msg, e.message, true);
  }
};

/* ---------- sales tab ---------- */

async function loadSales() {
  const boss = user.role === 'boss';
  $('#salesTitle').textContent = boss ? 'All sales' : 'Your sales today';
  $('#salesHead').innerHTML =
    '<tr><th>Receipt</th><th>Time</th>' +
    (boss ? '<th>Cashier</th>' : '') +
    '<th>Payment</th><th class="num">Total</th>' +
    (boss ? '<th class="num">Profit</th>' : '') +
    '<th></th></tr>';
  const rows = await api('/api/sales');
  $('#salesBody').innerHTML = rows.length
    ? rows
        .map(
          (s) => `<tr>
            <td>${esc(s.receipt_no)}</td><td>${esc(s.created_at)}</td>
            ${boss ? `<td>${esc(s.cashier)}</td>` : ''}
            <td>${s.payment_method === 'mpesa' ? 'M-Pesa' : 'Cash'}</td>
            <td class="num">${money(s.total_amount)}</td>
            ${boss ? `<td class="num">${money(s.profit)}</td>` : ''}
            <td><button class="btn light small" data-receipt="${s.id}">Receipt</button></td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="empty">No sales yet.</td></tr>';
}
$('#salesBody').addEventListener('click', (e) => {
  const id = e.target.dataset.receipt;
  if (id) showReceipt(id);
});

/* ---------- audit tab (boss) ---------- */

async function loadAudit() {
  const rows = await api('/api/audit');
  $('#auditBody').innerHTML = rows
    .map(
      (a) => `<tr><td>${esc(a.created_at)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td>
        <td>${esc(a.details)}</td><td>${esc(a.ip_address)}</td></tr>`
    )
    .join('');
}
