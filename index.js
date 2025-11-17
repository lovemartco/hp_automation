// index.js — LoveMart → Honey's Place automation
// -----------------------------------------------
// Requirements: express, crypto, raw-body, axios, xmlbuilder2, dotenv
// Env vars: SHOPIFY_WEBHOOK_SECRET, SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN,
//           HP_ACCOUNT, HP_TOKEN, HP_DEFAULT_SHIP (optional),
//           POLL_INTERVAL_MINUTES (optional), PORT (optional)

// ------- TLS workaround for Honey's Place (legacy certificate) -------
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from 'express';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import axios from 'axios';
import { create } from 'xmlbuilder2';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// In-memory map: shopifyOrderId -> { reference, fulfilled }
const orderStore = Object.create(null);

// ---------- Helpers ----------
function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

async function verifyShopifyHmac(req, rawBody) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
  const header = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  const a = Buffer.from(header, 'utf8');
  const b = Buffer.from(digest, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function shipCodeFor(order) {
  const title = (order.shipping_lines?.[0]?.title || '').toLowerCase().trim();
  const map = {
    'usps priority': 'P002',
    'priority mail': 'P002',
    'fedex ground': 'F006',
    'ground': 'F006',
    'pickup': 'PICKUP',
    'local pickup': 'PICKUP'
  };
  return map[title] || process.env.HP_DEFAULT_SHIP || 'RTSHOP';
}

function buildHpOrderXml(order) {
  const shipping = order.shipping_address || order.billing_address || {};
  const items = (order.line_items || []).filter(li => li.sku);

  // Allow test override from the order note: e.g., "HPREF: TEST1002"
  const forcedRef = /\bHPREF:\s*([A-Z0-9#-]+)/i.exec(order.note || '')?.[1] || null;
  const reference = (forcedRef || String(order.name || order.id).replace(/^#/, '').toUpperCase());

  const xmlObj = {
    HPEnvelope: {
      account: process.env.HP_ACCOUNT,
      password: process.env.HP_TOKEN,
      order: {
        reference,
        shipby: shipCodeFor(order),
        date: new Date(order.created_at || Date.now()).toISOString().slice(0, 10),
        items: {
          item: items.map(li => ({ sku: li.sku, qty: li.quantity }))
        },
        last: shipping.last_name || '',
        first: shipping.first_name || '',
        address1: shipping.address1 || '',
        address2: shipping.address2 || '',
        city: shipping.city || '',
        state: shipping.province_code || shipping.province || '',
        zip: shipping.zip || '',
        country: shipping.country_code || shipping.country || 'US',
        phone: shipping.phone || order.phone || '',
        emailaddress: order.email || '',
        instructions: (order.note || '').substring(0, 250)
      }
    }
  };

  return create(xmlObj).end({ prettyPrint: false, declaration: { encoding: 'UTF-8' } });
}

function parseHpXmlToObject(xmlString) {
  try {
    // xmlbuilder2 can parse strings as well:
    const doc = create(xmlString);
    return doc.end({ format: 'object' });
  } catch {
    return undefined;
  }
}

// --- Honey's Place calls (always POST with form field "xmldata") ---
hpPost(xmlBody)

// Submit order; return { code, reference } or undefined
async function submitToHoney(xmlBody) {
  const data = await hpPost(xmlBody);
  const obj = parseHpXmlToObject(data);
  const env = obj?.HPEnvelope;
  return env ? { code: env.code ?? null, reference: env.reference ?? null, raw: data } : undefined;
}

// Query status; return object { status, trackingnumber1, shipagent, ... }
async function hpOrderStatus(reference) {
  const queryXml = create({
    HPEnvelope: {
      account: process.env.HP_ACCOUNT,
      password: process.env.HP_TOKEN,
      orderstatus: String(reference)
    }
  }).end({ prettyPrint: false, declaration: { encoding: 'UTF-8' } });

  const data = await hpPost(queryXml);
  const obj = parseHpXmlToObject(data);
  return obj?.HPEnvelope || {};
}

// ----- Shopify fulfillment -----
async function createShopifyFulfillment(orderId, { number, carrier }) {
  const shopDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const adminToken = process.env.SHOPIFY_ADMIN_TOKEN;

  // 1) Get fulfillment orders
  const listUrl = `https://${shopDomain}/admin/api/2024-10/orders/${orderId}/fulfillment_orders.json`;
  const { data: listData } = await axios.get(listUrl, {
    headers: { 'X-Shopify-Access-Token': adminToken }
  });

  const fOrder = listData.fulfillment_orders?.[0];
  if (!fOrder) {
    log('No fulfillment order found for', orderId);
    return;
  }

  // 2) Create fulfillment
  const fulfillmentUrl = `https://${shopDomain}/admin/api/2024-10/fulfillments.json`;
  const payload = {
    fulfillment: {
      message: "Fulfilled by Honey's Place",
      notify_customer: true,
      tracking_info: { number, company: carrier || '', url: '' },
      line_items_by_fulfillment_order: [
        {
          fulfillment_order_id: fOrder.id,
          fulfillment_order_line_items: fOrder.line_items.map(li => ({
            id: li.id,
            quantity: li.quantity
          }))
        }
      ]
    }
  };

  await axios.post(fulfillmentUrl, payload, {
    headers: {
      'X-Shopify-Access-Token': adminToken,
      'Content-Type': 'application/json'
    }
  });

  log(`Shopify fulfillment created for order ${orderId} with tracking ${number}`);
}

// ----- Poll statuses periodically -----
async function pollHpStatuses() {
  const entries = Object.entries(orderStore).filter(([, v]) => !v.fulfilled && v.reference);
  if (!entries.length) return;

  for (const [shopifyOrderId, info] of entries) {
    try {
      const statusObj = await hpOrderStatus(info.reference);
      const status = (statusObj.status || '').toLowerCase();

      if (status === 'shipped') {
        const tracking = statusObj.trackingnumber1 || '';
        const carrier = statusObj.shipagent || '';
        await createShopifyFulfillment(shopifyOrderId, { number: tracking, carrier });
        info.fulfilled = true;
        log(`Order ${shopifyOrderId} fulfilled. Tracking: ${tracking} (${carrier})`);
      } else {
        log(`Order ${shopifyOrderId} still ${status || 'pending'}`);
      }
    } catch (err) {
      log('Polling error for', shopifyOrderId, '-', err?.message || err);
    }
  }
}

// ----- Routes -----
// Health
app.get('/', (_req, res) => res.send("Honey's Place Automation running"));

// Shopify webhook: order payment (recommended) or order creation
app.post('/webhooks/shopify/orders-paid', async (req, res) => {
  try {
    const rawBody = await getRawBody(req);
    const ok = await verifyShopifyHmac(req, rawBody);
    if (!ok) {
      log('Invalid Shopify HMAC');
      return res.status(401).send('Invalid HMAC');
    }

    const order = JSON.parse(rawBody.toString('utf8'));

    // Guard: skip if no SKUs (HP will reject)
    const hasSku = (order.line_items || []).some(li => !!li.sku);
    if (!hasSku) {
      log('Skipping order with no SKUs', order.id);
      return res.sendStatus(200);
    }

    const xml = buildHpOrderXml(order);
    try {
      const result = await submitToHoney(xml);
      if (!result || result.code !== '100') {
        log('HP submission failed for', order.id, 'response:', result?.raw || result);
      } else {
        orderStore[order.id] = { reference: result.reference, fulfilled: false };
        log('Submitted order', order.id, 'to HP with reference', result.reference);
      }
      return res.sendStatus(200);
    } catch (err) {
      log('Error submitting to HP:', err?.message || err);
      return res.sendStatus(500);
    }
  } catch (err) {
    log('Webhook error:', err?.message || err);
    return res.sendStatus(500);
  }
});

// ----- Start server & poller -----
const port = Number(process.env.PORT || 3000);
app.listen(port, () => log(`HP Automation listening on port ${port}`));

const intervalMinutes = Math.max(1, parseInt(process.env.POLL_INTERVAL_MINUTES || '15', 10));
setInterval(() => {
  pollHpStatuses().catch(e => log('Polling error (interval):', e?.message || e));
}, intervalMinutes * 60 * 1000);

// Optional: first poll a bit later to catch freshly submitted test orders
setTimeout(() => {
  pollHpStatuses().catch(e => log('Initial poll error:', e?.message || e));
}, 30 * 1000);
