require('dotenv').config();
console.log("ENV DEBUG:", process.env.SHOPIFY_STORE);
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { google } = require('googleapis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── GOOGLE SHEETS SETUP ──────────────────────────
let sheetsCredentials;

try {
  sheetsCredentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_SHEETS_CREDS_BASE64, "base64").toString()
  );
  console.log("✅ Google creds loaded");
} catch (err) {
  console.error("❌ Google creds failed:", err.message);
}
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Sheet1'; // tab name


const sheetsCredentials = JSON.parse(
  Buffer.from(process.env.GOOGLE_SHEETS_CREDS_BASE64, 'base64').toString()
);

const auth = new google.auth.JWT(
  sheetsCredentials.client_email,
  null,
  sheetsCredentials.private_key.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

// ─── ENV CONFIG ─────────────────────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
let PRICE_RULE_ID = process.env.PRICE_RULE_ID || null;
const DISCOUNT_PERCENT = parseInt(process.env.DISCOUNT_PERCENT || '10');
const CODE_PREFIX = process.env.CODE_PREFIX || 'THANKS';
const PORT = process.env.PORT || 3000;

// ─── EMAIL DB (FILE BASED) ─────────────────────────
const EMAIL_DB = './emails.json';
function getEmails() {
  if (!fs.existsSync(EMAIL_DB)) return [];
  return JSON.parse(fs.readFileSync(EMAIL_DB));
}

function saveEmail(email, code, name, order) {
  const emails = getEmails();
  emails.push({
    name,
    email,
    order,
    code,
    date: new Date().toISOString()
  });
  fs.writeFileSync(EMAIL_DB, JSON.stringify(emails, null, 2));
}

// ─── Generate random code ───────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 8; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${CODE_PREFIX}-${suffix}`;
}

// ─── Create Price Rule ──────────────────────────────
async function createPriceRule() {
  const url = `https://${SHOPIFY_STORE}/admin/api/2026-01/price_rules.json`;
  const body = {
    price_rule: {
      title: `AUTO-3-STAR-${Date.now()}`,
      target_type: "line_item",
      target_selection: "all",
      allocation_method: "across",
      value_type: "percentage",
      value: `-${DISCOUNT_PERCENT}.0`,
      customer_selection: "all",
      once_per_customer: true,
      usage_limit: null,
      starts_at: new Date().toISOString()
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

  PRICE_RULE_ID = data.price_rule.id;
  console.log("✅ Price Rule Created:", PRICE_RULE_ID);
  return PRICE_RULE_ID;
}

// ─── Create Discount Code ──────────────────────────
async function createShopifyDiscount(code) {
  if (!PRICE_RULE_ID) await createPriceRule();

  const url = `https://${SHOPIFY_STORE}/admin/api/2026-01/price_rules/${PRICE_RULE_ID}/discount_codes.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ discount_code: { code } })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

  return data.discount_code || data.discount_codes[0];
}

// ─── API: CREATE DISCOUNT ──────────────────────────
app.post('/api/create-discount', async (req, res) => {
  const { name, email, phone, order, review, stars } = req.body;

  // 1️⃣ Basic validation
  if (!name || !email || !phone || !order || !review || !stars) {
    return res.status(400).json({ error: 'All fields required' });
  }

  if (stars > 3) {
    return res.status(400).json({ error: 'Only for 3-star rating' });
  }

  const emails = getEmails();

  // 2️⃣ Email duplicate check
  if (emails.find(e => e.email === email)) {
    return res.status(400).json({ error: 'You have already claimed a discount!' });
  }

  // 3️⃣ Order duplicate check
  if (emails.find(e => e.order === order)) {
    return res.status(400).json({ error: 'This order has already been used for a discount!' });
  }

  try {

    // 5️⃣ Generate discount
    const code = generateCode();
    await createShopifyDiscount(code);

    // 6️⃣ Save data
    saveEmail(email, code, name, order);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:E`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[name, email, order, code, new Date().toISOString()]]
      },
    });

    return res.json({
      success: true,
      code
    });

  } catch (err) {
    console.error(" ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Health Check ──────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    price_rule: PRICE_RULE_ID || 'Not created yet'
  });
});

// ─── Admin Page for Emails ─────────────────────────
app.get('/admin/emails', (req, res) => {
  if (!fs.existsSync(EMAIL_DB)) return res.send('<h3>No data found</h3>');
  const emails = JSON.parse(fs.readFileSync(EMAIL_DB));

  let html = `
    <h2>Discount Codes Claimed</h2>
    <table border="1" cellpadding="8" cellspacing="0">
      <tr><th>Email</th><th>Discount Code</th><th>Date Claimed</th></tr>
  `;
  emails.forEach(e => {
    html += `<tr><td>${e.email}</td><td>${e.code}</td><td>${e.date}</td></tr>`;
  });
  html += `</table><br><a href="/api/emails/csv">Download CSV</a>`;
  res.send(html);
});

async function verifyShopifyOrder(orderNumber) {
  const cleanOrder = orderNumber.replace('#', '');

  const url = `https://${SHOPIFY_STORE}/admin/api/2026-01/orders.json?name=%23${cleanOrder}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    }
  });

  const data = await res.json();

  if (!res.ok) throw new Error('Shopify API error');

  return data.orders && data.orders.length > 0 ? data.orders[0] : null;
}

// ─── Start Server ─────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
