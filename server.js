require('dotenv').config();

console.log("ENV DEBUG:", process.env.SHOPIFY_STORE);
console.log("GOOGLE_SHEETS_CREDS exists:", !!process.env.GOOGLE_SHEETS_CREDS);
console.log("SPREADSHEET_ID:", process.env.SPREADSHEET_ID);

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
let sheetsCredentials = null;

try {
  if (!process.env.GOOGLE_SHEETS_CREDS) {
    throw new Error('GOOGLE_SHEETS_CREDS ENV missing');
  }

  sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDS);

  if (sheetsCredentials.private_key) {
    sheetsCredentials.private_key =
      sheetsCredentials.private_key.replace(/\\n/g, '\n');
  }

  console.log('✅ Google creds loaded successfully');
  console.log('Sheets Creds Loaded:', !!sheetsCredentials);
  console.log('Client Email:', sheetsCredentials?.client_email);
} catch (err) {
  console.error('❌ Google creds problem:', err.message);
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Sheet1';

// Use ENV credentials instead of requiring a local google-creds.json file.
const auth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials || undefined,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({
  version: 'v4',
  auth
});

// ─── ENV CONFIG ─────────────────────────────────────
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

let PRICE_RULE_ID = process.env.PRICE_RULE_ID || null;

const HIGH_DISCOUNT_PERCENT = parseInt(
  process.env.HIGH_DISCOUNT_PERCENT || '10',
  10
);

const LOW_DISCOUNT_PERCENT = parseInt(
  process.env.LOW_DISCOUNT_PERCENT || '5',
  10
);

const CODE_PREFIX = process.env.CODE_PREFIX || 'THANKS';
const PORT = process.env.PORT || 3000;

// Public review URLs.
// Set these in .env for the actual product/store.
const AMAZON_REVIEW_URL =
  process.env.AMAZON_REVIEW_URL ||
  'https://www.amazon.com/review/create-review?asin=XXXXXXXXXX';

const SHOPIFY_REVIEW_URL =
  process.env.SHOPIFY_REVIEW_URL || '';

// ─── EMAIL DB (FILE BASED) ─────────────────────────
const EMAIL_DB = path.join(__dirname, 'emails.json');

function getEmails() {
  if (!fs.existsSync(EMAIL_DB)) return [];

  try {
    return JSON.parse(fs.readFileSync(EMAIL_DB, 'utf8'));
  } catch {
    return [];
  }
}

function saveEmail(email, code, name, platform, order, stars) {
  const emails = getEmails();

  emails.push({
    name,
    email,
    platform,
    order,
    stars,
    code,
    date: new Date().toISOString()
  });

  fs.writeFileSync(
    EMAIL_DB,
    JSON.stringify(emails, null, 2)
  );
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
// Price rules are created per discount percentage so the
// high-rating and low-rating discounts can have different values.
async function createPriceRule(discountPercent) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    throw new Error('Shopify configuration is missing.');
  }

  const url =
    `https://${SHOPIFY_STORE}/admin/api/2026-01/price_rules.json`;

  const body = {
    price_rule: {
      title: `AUTO-${discountPercent}-PERCENT-${Date.now()}`,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: 'percentage',
      value: `-${discountPercent}.0`,
      customer_selection: 'all',
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

  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  console.log(
    `✅ ${discountPercent}% Price Rule Created:`,
    data.price_rule.id
  );

  return data.price_rule.id;
}

// ─── Create Discount Code ──────────────────────────
async function createShopifyDiscount(code, discountPercent) {
  const priceRuleId = await createPriceRule(discountPercent);

  const url =
    `https://${SHOPIFY_STORE}/admin/api/2026-01/price_rules/${priceRuleId}/discount_codes.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      discount_code: {
        code
      }
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data.discount_code || data.discount_codes?.[0];
}

// ─── API: CREATE DISCOUNT ──────────────────────────
app.post('/api/create-discount', async (req, res) => {
  const {
    name,
    email,
    phone,
    platform,
    order,
    review,
    stars
  } = req.body;

  // 1. Basic validation
  if (
    !name ||
    !email ||
    !phone ||
    !platform ||
    !order ||
    !review ||
    !stars
  ) {
    return res.status(400).json({
      error: 'All fields required'
    });
  }

  if (!['amazon', 'shopify'].includes(platform)) {
    return res.status(400).json({
      error: 'Invalid platform'
    });
  }

  const numericStars = Number(stars);

  if (
    !Number.isInteger(numericStars) ||
    numericStars < 1 ||
    numericStars > 5
  ) {
    return res.status(400).json({
      error: 'Invalid star rating'
    });
  }

  // Amazon order validation
  if (platform === 'amazon') {
    const amazonOrderRegex =
      /^\d{3}-\d{7}-\d{7}$|^\d{10,20}$/;

    if (!amazonOrderRegex.test(order)) {
      return res.status(400).json({
        error: 'Invalid Amazon order number'
      });
    }
  }

  // Webstore / Shopify order validation
  if (platform === 'shopify') {
    const shopifyOrderRegex = /^#?\d{1,10}$/;

    if (!shopifyOrderRegex.test(order)) {
      return res.status(400).json({
        error: 'Invalid Webstore order number'
      });
    }
  }

  const emails = getEmails();

  // 2. Email duplicate check
  if (
    emails.some(
      e => String(e.email).toLowerCase() === email.toLowerCase()
    )
  ) {
    return res.status(400).json({
      error: 'You have already claimed a discount!'
    });
  }

  // 3. Order duplicate check
  if (
    emails.some(
      e =>
        e.order === order &&
        e.platform === platform
    )
  ) {
    return res.status(400).json({
      error: 'This order has already been used for a discount!'
    });
  }

  try {
    // 4. High rating = higher discount.
    // Lower than 4 = lower discount.
    const isPositive = numericStars >= 4;

    const discountPercent = isPositive
      ? HIGH_DISCOUNT_PERCENT
      : LOW_DISCOUNT_PERCENT;

    // 5. Generate discount
    const code = generateCode();

    await createShopifyDiscount(
      code,
      discountPercent
    );

    // 6. Save data
    saveEmail(
      email,
      code,
      name,
      platform,
      order,
      numericStars
    );

    // 7. Save to Google Sheets
    if (SPREADSHEET_ID && sheetsCredentials) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:G`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[
            name,
            email,
            platform === 'shopify' ? 'Webstore' : 'Amazon',
            order,
            numericStars,
            code,
            new Date().toISOString()
          ]]
        }
      });
    }

    // 8. Return the correct review URL.
    // Only positive ratings receive the external review-page URL.
    let reviewUrl = null;

    if (isPositive) {
      reviewUrl =
        platform === 'amazon'
          ? AMAZON_REVIEW_URL
          : SHOPIFY_REVIEW_URL;
    }

    return res.json({
      success: true,
      code,
      discountPercent,
      positive: isPositive,
      reviewUrl
    });

  } catch (err) {
    console.error('❌ ERROR:', err.message);

    return res.status(500).json({
      error: err.message
    });
  }
});

// ─── Health Check ──────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    high_discount: `${HIGH_DISCOUNT_PERCENT}%`,
    low_discount: `${LOW_DISCOUNT_PERCENT}%`
  });
});

// ─── Admin Page for Emails ─────────────────────────
app.get('/admin/emails', (req, res) => {
  if (!fs.existsSync(EMAIL_DB)) {
    return res.send('<h3>No data found</h3>');
  }

  const emails = JSON.parse(
    fs.readFileSync(EMAIL_DB, 'utf8')
  );

  let html = `
    <h2>Discount Codes Claimed</h2>
    <table border="1" cellpadding="8" cellspacing="0">
      <tr>
        <th>Name</th>
        <th>Email</th>
        <th>Platform</th>
        <th>Order</th>
        <th>Stars</th>
        <th>Discount Code</th>
        <th>Date Claimed</th>
      </tr>
  `;

  emails.forEach(e => {
    html += `
      <tr>
        <td>${e.name || ''}</td>
        <td>${e.email || ''}</td>
        <td>${e.platform || ''}</td>
        <td>${e.order || ''}</td>
        <td>${e.stars || ''}</td>
        <td>${e.code || ''}</td>
        <td>${e.date || ''}</td>
      </tr>
    `;
  });

  html += `
    </table>
  `;

  res.send(html);
});

// ─── Test Google Sheet ─────────────────────────────
app.get('/test-sheet', async (req, res) => {
  try {
    if (!SPREADSHEET_ID || !sheetsCredentials) {
      return res.status(500).send(
        'Google Sheets configuration is missing.'
      );
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:G`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          'Test',
          'test@gmail.com',
          'Webstore',
          '123',
          5,
          'CODE123',
          new Date().toISOString()
        ]]
      }
    });

    res.send('Sheet Updated Successfully');

  } catch (error) {
    console.error('SHEET ERROR:', error);
    res.status(500).send(error.message);
  }
});

// ─── Start Server ─────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
