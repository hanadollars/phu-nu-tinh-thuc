// api/sepay-webhook.js — Đại Nữ Chủ · Cẩm Nang Tịnh Thức
// CommonJS – no npm packages needed

const ORDER_CODE_REGEX = /FNT[A-Z0-9]{4}/i;
const EINVOICE_BASE = 'https://einvoice-api.sepay.vn';
const PRICE = 99000;

/* ── KV helpers ── */
async function kvGet(key) {
  const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  const data = await r.json();
  return data.result;
}
async function kvSet(key, value, ex) {
  await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['SET', key, value, 'EX', ex]),
  });
}
async function kvIncr(key) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['INCR', key]),
  });
  const data = await r.json();
  return data.result;
}

/* ── Resend email ── */
async function sendEmail({ to, subject, html }) {
  const fromEmail = process.env.FROM_EMAIL || 'no-reply@hanadola.com';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: fromEmail, to, subject, html }),
  });
  const text = await r.text();
  console.log('[Resend] TO:', to, '| status:', r.status, '| resp:', text);
}

/* ── SePay eInvoice ── */
async function createEInvoice({ order, transferAmount }) {
  const clientId          = process.env.SEPAY_EINVOICE_CLIENT_ID;
  const clientSecret      = process.env.SEPAY_EINVOICE_CLIENT_SECRET;
  const providerAccountId = process.env.SEPAY_EINVOICE_PROVIDER_ACCOUNT_ID;
  const templateCode      = process.env.SEPAY_EINVOICE_TEMPLATE_CODE;
  const invoiceSeries     = process.env.SEPAY_EINVOICE_SERIES;

  if (!clientId || !clientSecret || !providerAccountId) {
    console.log('[eInvoice] Thiếu biến môi trường — bỏ qua');
    return null;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenRes = await fetch(`${EINVOICE_BASE}/v1/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
  });
  const tokenData = await tokenRes.json();
  const token = tokenData?.data?.access_token;
  if (!token) return null;

  const issuedDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const payload = {
    template_code:        templateCode,
    invoice_series:       invoiceSeries,
    issued_date:          issuedDate,
    currency:             'VND',
    provider_account_id:  providerAccountId,
    payment_method:       'CK',
    buyer: { name: order.name, email: order.email },
    items: [{
      line_number: 1,
      line_type:   1,
      item_code:   'FNT-001',
      item_name:   'Đại Nữ Chủ — Cẩm Nang Tịnh Thức (Bộ Nội Dung Thực Hành)',
      unit:        'Bộ',
      quantity:    1,
      unit_price:  transferAmount || PRICE,
      tax_rate:    -2,
    }],
    is_draft:        false,
    auto_send_buyer: true,
  };

  const invoiceRes = await fetch(`${EINVOICE_BASE}/v1/invoices/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const invoiceData = await invoiceRes.json();
  console.log('[eInvoice] Create response:', JSON.stringify(invoiceData)?.slice(0, 300));
  const data = invoiceData?.data || null;
  if (!data) return null;

  const trackingCode = data.tracking_code;
  console.log('[eInvoice] tracking_code:', trackingCode, '| view_url:', data.view_url || data.pdf_url || null);

  if (trackingCode) {
    try {
      const releaseRes = await fetch(`${EINVOICE_BASE}/v1/invoices/release`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracking_codes: [trackingCode] }),
      });
      const releaseText = await releaseRes.text();
      console.log('[eInvoice] Release status:', releaseRes.status, '| body:', releaseText?.slice(0, 200));
      if (releaseText && releaseText.trim()) {
        try {
          const releaseData = JSON.parse(releaseText);
          if (releaseData?.data) Object.assign(data, releaseData.data);
        } catch (e) {
          console.error('[eInvoice] Release parse error:', e.message);
        }
      }
    } catch (err) {
      console.error('[eInvoice] Release error:', err.message);
    }
  }
  return data;
}

/* ── Webhook handler ── */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const expectedToken = process.env.SEPAY_API_KEY;
  if (expectedToken && authHeader !== `Apikey ${expectedToken}`) {
    console.warn('[Webhook] Auth thất bại:', authHeader);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  console.log('[Webhook] Nhận:', JSON.stringify(body));

  const content = body.content || body.description || '';
  const transferAmount = Number(body.transferAmount || body.amount || 0);

  const match = content.match(ORDER_CODE_REGEX);
  if (!match) {
    console.log('[Webhook] Không tìm thấy mã FNT trong:', content);
    return res.status(200).json({ success: false, message: 'Không tìm thấy mã đơn hàng' });
  }

  const orderCode = match[0].toUpperCase();
  const raw = await kvGet(`order:${orderCode}`);
  if (!raw) return res.status(200).json({ success: false, message: 'Không tìm thấy đơn hàng' });

  const order = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (transferAmount < PRICE) {
    return res.status(200).json({ success: false, message: 'Số tiền không đủ' });
  }
  if (order.status === 'paid') {
    return res.status(200).json({ success: true, message: 'Đã xử lý trước đó' });
  }

  const paidAt = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const fileUrl = process.env.FILE_URL || '#';

  order.status = 'paid';
  order.paidAt = paidAt;
  order.transferAmount = transferAmount;
  order.fileUrl = fileUrl;
  await kvSet(`order:${orderCode}`, JSON.stringify(order), 86400 * 30);

  const counter = await kvIncr('fnt_invoice_counter');
  const invoiceNumber = `HD-FNT-2026-${String(counter).padStart(4, '0')}`;

  let einvoiceData = null;
  let invoiceViewUrl = null;
  try {
    einvoiceData = await createEInvoice({ order, transferAmount });
    if (einvoiceData) {
      order.invoiceTrackingCode = einvoiceData.tracking_code || null;
      order.invoiceNumber = invoiceNumber;
      invoiceViewUrl = einvoiceData.view_url || einvoiceData.pdf_url || null;
      if (invoiceViewUrl) order.invoiceViewUrl = invoiceViewUrl;
      await kvSet(`order:${orderCode}`, JSON.stringify(order), 86400 * 30);
    }
  } catch (err) {
    console.error('[eInvoice] Lỗi:', err.message);
  }

  const amountFormatted = (transferAmount || PRICE).toLocaleString('vi-VN') + ' ₫';

  // Email khách hàng
  try {
    await sendEmail({
      to: order.email,
      subject: `✅ Thanh toán thành công — Đại Nữ Chủ · Cẩm Nang Tịnh Thức`,
      html: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><style>
body{font-family:'Segoe UI',Arial,sans-serif;background:#0F0A18;color:#FDF8FF;margin:0;padding:0}
.wrap{max-width:520px;margin:0 auto;padding:40px 24px}
.brand{font-size:10px;letter-spacing:3px;color:rgba(196,48,106,0.5);text-transform:uppercase;margin-bottom:28px}
h1{font-size:22px;font-weight:300;margin-bottom:6px;color:#FDF8FF}
h1 em{font-style:italic;color:#F4A0B8}
p{font-size:14px;color:rgba(253,248,255,0.6);line-height:1.8;margin-bottom:14px}
.box{background:rgba(255,255,255,0.04);border:1px solid rgba(196,48,106,0.25);border-radius:10px;padding:20px 24px;margin:20px 0}
.box-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.08);font-size:13px}
.box-row:last-child{border-bottom:none}
.box-label{color:rgba(253,248,255,0.4)}
.box-val{color:#FDF8FF;font-weight:600}
.inv{color:#F4A0B8;font-weight:700}
.btn{display:block;background:linear-gradient(135deg,#C4306A,#7B2DBF);color:#fff;text-align:center;padding:16px;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none;margin:24px 0}
.note{font-size:11px;color:rgba(196,48,106,0.4);line-height:1.7}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid rgba(196,48,106,0.1);font-size:11px;color:rgba(253,248,255,0.2);text-align:center}
</style></head><body><div class="wrap">
<div class="brand">Hanadola Media &amp; Technology · Đại Nữ Chủ</div>
<h1>Hành trình của bạn bắt đầu rồi, <em>${order.name}</em> ✨</h1>
<p>Thanh toán đã được xác nhận. Cẩm nang thực hành của bạn đã sẵn sàng bên dưới.</p>
<div class="box">
  <div class="box-row"><span class="box-label">Sản phẩm</span><span class="box-val">Đại Nữ Chủ — Cẩm Nang Tịnh Thức</span></div>
  <div class="box-row"><span class="box-label">Mã đơn hàng</span><span class="box-val">${orderCode}</span></div>
  <div class="box-row"><span class="box-label">Số hóa đơn</span><span class="box-val inv">${invoiceNumber}</span></div>
  <div class="box-row"><span class="box-label">Số tiền</span><span class="box-val">${amountFormatted}</span></div>
  <div class="box-row"><span class="box-label">Thanh toán lúc</span><span class="box-val">${paidAt}</span></div>
</div>
<a href="${fileUrl}" class="btn">✨ Nhận Cẩm Nang Ngay</a>
${invoiceViewUrl ? `<a href="${invoiceViewUrl}" style="display:block;text-align:center;margin:-12px 0 24px;font-size:13px;color:#F4A0B8;text-decoration:underline">📄 Xem / Tải hóa đơn VAT điện tử</a>` : ''}
<p class="note">🔒 Nội dung được cấp phép cá nhân. Vui lòng không chia sẻ hoặc phân phối lại.<br>Cần hỗ trợ: <strong style="color:#FDF8FF">admin@hanadola.com</strong> · 0935.251.866</p>
<div class="footer">© 2026 Công ty TNHH Hanadola Media &amp; Technology<br>P903, Tầng 9, Diamond Plaza, 34 Lê Duẩn, TP.HCM · MST: 0319352856</div>
</div></body></html>`,
    });
  } catch (err) {
    console.error('[Email] Lỗi gửi email khách:', err.message);
  }

  // Email admin
  const notifyEmail = process.env.NOTIFY_EMAIL;
  if (notifyEmail) {
    try {
      await sendEmail({
        to: notifyEmail,
        subject: `[FNT] Đơn hàng mới — ${orderCode} — ${order.name}`,
        html: `<div style="font-family:'Segoe UI',sans-serif;max-width:480px;padding:24px;background:#1A0D2E;color:#FDF8FF;border-radius:8px">
<h2 style="color:#F4A0B8;font-size:18px;margin-bottom:16px">💜 Đơn hàng mới — Đại Nữ Chủ</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px">
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);color:rgba(253,248,255,0.4);width:40%">Khách hàng</td><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);font-weight:600">${order.name}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);color:rgba(253,248,255,0.4)">Email</td><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1)">${order.email}</td></tr>
  ${order.phone ? `<tr><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);color:rgba(253,248,255,0.4)">Điện thoại</td><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1)">${order.phone}</td></tr>` : ''}
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);color:rgba(253,248,255,0.4)">Mã đơn</td><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);color:#F4A0B8;font-weight:700">${orderCode}</td></tr>
  <tr><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);color:rgba(253,248,255,0.4)">Số hóa đơn</td><td style="padding:8px 0;border-bottom:1px solid rgba(196,48,106,0.1);color:#F4A0B8">${invoiceNumber}</td></tr>
  <tr><td style="padding:8px 0;color:rgba(253,248,255,0.4)">Số tiền</td><td style="padding:8px 0">${amountFormatted}</td></tr>
</table></div>`,
      });
    } catch (err) {
      console.error('[Email] Lỗi gửi admin:', err.message);
    }
  }

  return res.status(200).json({ success: true, orderCode, invoiceNumber });
};
