import express from 'express';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import axios from 'axios';
import { create } from 'xmlbuilder2';
import dotenv from 'dotenv';

// Load environment variables from .env file.  You should copy .env.sample to .env and
// fill in your own secrets before running the service.
dotenv.config();

const app = express();

/*
 * This service listens for Shopify webhooks when orders are placed (or paid) and
 * submits those orders to Honey's Place using their XML API.  It also
 * periodically polls Honey's Place for shipment status and, when the order has
 * shipped, creates a fulfillment in Shopify with the tracking number.  The
 * service stores order mappings in memory.  For production use you should
 * replace the in‑memory map with a persistent database such as SQLite,
 * Postgres, or DynamoDB.
 */

// In‑memory store of submitted orders.  Keys are the Shopify order ID and
// values contain the reference sent to Honey's Place along with a flag for
// whether the order has been fulfilled.
const orderStore = {};

/**
 * Verify the HMAC signature of the Shopify webhook using the secret
 * configured in your .env file.  Shopify includes a Base64 HMAC hash in the
 * `X‑Shopify‑Hmac‑Sha256` header.  This function recalculates the HMAC over
 * the raw request body and compares the two hashes in a timing‑safe manner.
 *
 * @param {Object} req Express request
 * @param {Buffer} rawBody Raw request body
 * @returns {boolean} True if the HMAC matches, false otherwise
 */
async function verifyShopifyHmac(req, rawBody) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const header = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  // Use timingSafeEqual to mitigate timing attacks
  const hashBuffer = Buffer.from(header, 'utf8');
  const digestBuffer = Buffer.from(digest, 'utf8');
  if (hashBuffer.length !== digestBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, digestBuffer);
}

/**
 * Determine the shipping code for an order.  You can map different shipping
 * methods from Shopify to Honey's Place codes here.  The default falls back
 * to the environment variable HP_DEFAULT_SHIP or 'RTSHOP' (best rate).
 *
 * @param {Object} order Shopify order JSON
 * @returns {string} Shipping code accepted by Honey's Place
 */
function shipCodeFor(order) {
  const title = (order.shipping_lines?.[0]?.title || '').toLowerCase();
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

/**
 * Build the Honey's Place XML envelope for an order.  Only items with a SKU
 * are sent.  If there are no valid items the returned XML will omit the
 * `<item>` elements; Honey's Place will reject such orders so you should
 * validate your SKUs in Shopify.
 *
 * @param {Object} order Shopify order JSON
 * @returns {string} XML payload as a string
 */
function buildHpOrderXml(order) {
  const shipping = order.shipping_address || order.billing_address || {};
  const items = (order.line_items || []).filter(item => item.sku);

  const xmlObj = {
    HPEnvelope: {
      account: process.env.HP_ACCOUNT,
      password: process.env.HP_TOKEN,
      order: {
        reference: String(order.name || order.id).replace(/^#/, '').toUpperCase(),
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

/**
 * Submit an order to Honey's Place.  Returns the parsed XML response as a
 * string.  Honey's Place accepts either a POST with Content‑Type
 * application/xml or a form field named `xmldata`.
 *
 * @param {string} xmlBody XML payload
 * @returns {Promise<string>} HP response body
 */
async function submitToHoney(xmlBody) {
  const res = await axios.post(
    'https://www.honeysplace.com/ws/',
    xmlBody,
    {
      headers: { 'Content-Type': 'application/xml' },
      timeout: 20000
    }
  );
  return res.data;
}

/**
 * Extract the code and reference from a Honey's Place submission response.  The
 * response may include additional fields such as details; we only parse what
 * we need here.  If the response is not valid XML the function returns
 * undefined.
 *
 * @param {string} xml XML string returned from HP
 * @returns {Object|undefined} Parsed result with code and reference
 */
function parseHpSubmissionResponse(xml) {
  try {
    const doc = create(xml).end({ format: 'object' });
    const ref = doc.HPEnvelope?.reference || null;
    const code = doc.HPEnvelope?.code || null;
    return { code, reference: ref };
  } catch (err) {
    return undefined;
  }
}

/**
 * Submit a fulfillment to Shopify.  This marks the order as shipped and
 * attaches the tracking number to the order.  It uses the Fulfillment API
 * endpoint on the stable 2024‑10 version.  Note that Shopify requires
 * obtaining a fulfillment order ID for each order; here we fetch the
 * fulfillment orders list first then use the first entry.  For stores with
 * multiple locations you may need more complex logic.
 *
 * @param {number|string} orderId Shopify order ID
 * @param {Object} tracking Tracking details
 */
async function createShopifyFulfillment(orderId, tracking) {
  // Step 1: get fulfillment orders
  const listUrl = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-10/orders/${orderId}/fulfillment_orders.json`;
  const { data: listData } = await axios.get(listUrl, {
    headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN }
  });
  const fulfillmentOrder = listData.fulfillment_orders?.[0];
  if (!fulfillmentOrder) return;
  const fulfillmentUrl = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-10/fulfillments.json`;
  const payload = {
    fulfillment: {
      message: 'Fulfilled by Honey\'s Place',
      notify_customer: true,
      tracking_info: {
        number: tracking.number,
        company: tracking.carrier,
        url: ''
      },
      line_items_by_fulfillment_order: [
        {
          fulfillment_order_id: fulfillmentOrder.id,
          fulfillment_order_line_items: fulfillmentOrder.line_items.map(li => ({ id: li.id, quantity: li.quantity }))
        }
      ]
    }
  };
  await axios.post(fulfillmentUrl, payload, {
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Poll Honey's Place for order status.  For each order in the in‑memory
 * store that has not yet been fulfilled, call the order status API and if
 * shipped then create a fulfillment in Shopify and mark the order fulfilled
 * locally.  You should call this function periodically (e.g. via
 * setInterval).
 */
async function pollHpStatuses() {
  const entries = Object.entries(orderStore).filter(([, v]) => !v.fulfilled);
  for (const [shopifyOrderId, info] of entries) {
    const xmlObj = {
      HPEnvelope: {
        account: process.env.HP_ACCOUNT,
        password: process.env.HP_TOKEN,
        orderstatus: info.reference
      }
    };
    const xmlBody = create(xmlObj).end({ prettyPrint: false, declaration: { encoding: 'UTF-8' } });
    try {
      const res = await axios.post(
  'https://www.honeysplace.com/ws/',
  `xmldata=${encodeURIComponent(xmlBody)}`,
  {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  }
);
      const body = res.data;
      // Parse status and tracking numbers
      const doc = create(body).end({ format: 'object' });
      const status = doc.HPEnvelope?.status || '';
      if (status.toLowerCase() === 'shipped') {
        const trackingNumber = doc.HPEnvelope?.trackingnumber1 || '';
        const carrier = doc.HPEnvelope?.shipagent || '';
        await createShopifyFulfillment(shopifyOrderId, { number: trackingNumber, carrier });
        info.fulfilled = true;
        console.log(`Order ${shopifyOrderId} fulfilled with tracking ${trackingNumber}`);
      }
    } catch (err) {
      console.error('Failed to poll status for order', shopifyOrderId, err.message);
    }
  }
}

// Express handler for Shopify webhooks
app.post('/webhooks/shopify/orders-paid', async (req, res) => {
  try {
    const rawBody = await getRawBody(req);
    const valid = await verifyShopifyHmac(req, rawBody);
    if (!valid) {
      return res.status(401).send('Invalid HMAC');
    }
    const order = JSON.parse(rawBody.toString('utf8'));
    const xml = buildHpOrderXml(order);
    try {
      const responseBody = await submitToHoney(xml);
      const parsed = parseHpSubmissionResponse(responseBody);
      if (!parsed || parsed.code !== '100') {
        console.error('HP submission failed for order', order.id, responseBody);
      } else {
        // Save mapping for later polling
        orderStore[order.id] = { reference: parsed.reference, fulfilled: false };
        console.log('Submitted order', order.id, 'to HP with reference', parsed.reference);
      }
      res.sendStatus(200);
    } catch (err) {
      console.error('Error submitting to HP:', err.message);
      res.sendStatus(500);
    }
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// Healthcheck endpoint
app.get('/', (req, res) => {
  res.send('Honey\'s Place Automation running');
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`HP Automation listening on port ${port}`);
});

// Start polling for statuses every 15 minutes
const intervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES || '15', 10);
setInterval(() => {
  pollHpStatuses().catch(err => console.error('Polling error', err));
}, intervalMinutes * 60 * 1000);