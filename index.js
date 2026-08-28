// index.js — LoveMart → Honey's Place automation (Render)
// -------------------------------------------------------
// Env vars required:
// SHOPIFY_WEBHOOK_SECRET, SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN,
// HP_ACCOUNT, HP_TOKEN, DATABASE_URL
//
// Optional:
// HP_DEFAULT_SHIP (default RTSHOP)
// POLL_INTERVAL_MINUTES (default 15)
// PORT (default 3000)

// ---- TLS workaround for Honey's Place (legacy certificate chain) ----
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from 'express';
import crypto from 'crypto';
import getRawBody from 'raw-body';
import axios from 'axios';
import { create } from 'xmlbuilder2';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

db.on('error', err => {
  console.error(
    new Date().toISOString(),
    '- Unexpected PostgreSQL error:',
    err?.message || err
  );
});

const app = express();

// -------------------------------------------------------
// Logging
// -------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// -------------------------------------------------------
// PostgreSQL helpers
// -------------------------------------------------------

async function reserveSupplierOrder(shopifyOrderId, hpReference) {
  const result = await db.query(
    `
      INSERT INTO supplier_orders (
        shopify_order_id,
        hp_reference,
        hp_status,
        fulfilled,
        retry_count,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'reserved',
        false,
        0,
        NOW(),
        NOW()
      )
      ON CONFLICT (shopify_order_id)
      DO NOTHING
      RETURNING shopify_order_id
    `,
    [
      String(shopifyOrderId),
      String(hpReference)
    ]
  );

  return result.rowCount === 1;
}

async function markSupplierOrderSubmitted(
  shopifyOrderId,
  hpReference
) {
  await db.query(
    `
      UPDATE supplier_orders
      SET
        hp_reference = $2,
        hp_status = 'submitted',
        last_error = NULL,
        updated_at = NOW()
      WHERE shopify_order_id = $1
    `,
    [
      String(shopifyOrderId),
      String(hpReference)
    ]
  );
}

async function markSupplierSubmissionError(
  shopifyOrderId,
  errorMessage
) {
  await db.query(
    `
      UPDATE supplier_orders
      SET
        hp_status = 'submission_error',
        last_error = $2,
        retry_count = retry_count + 1,
        updated_at = NOW()
      WHERE shopify_order_id = $1
    `,
    [
      String(shopifyOrderId),
      String(errorMessage || 'Unknown HP submission error').slice(0, 1000)
    ]
  );
}

async function getPendingSupplierOrders() {
  const result = await db.query(
    `
      SELECT
        shopify_order_id,
        hp_reference,
        hp_status,
        fulfilled,
        tracking_number,
        carrier,
        last_polled_at,
        last_error,
        retry_count
      FROM supplier_orders
      WHERE
        fulfilled = false
        AND hp_reference IS NOT NULL
      ORDER BY created_at ASC
    `
  );

  return result.rows;
}

async function updateSupplierPollStatus(
  shopifyOrderId,
  {
    hpStatus = null,
    trackingNumber = null,
    carrier = null,
    lastError = null,
    incrementRetry = false
  } = {}
) {
  await db.query(
    `
      UPDATE supplier_orders
      SET
        hp_status = COALESCE($2, hp_status),
        tracking_number = COALESCE($3, tracking_number),
        carrier = COALESCE($4, carrier),
        last_error = $5,
        retry_count = CASE
          WHEN $6 = true THEN retry_count + 1
          ELSE retry_count
        END,
        last_polled_at = NOW(),
        updated_at = NOW()
      WHERE shopify_order_id = $1
    `,
    [
      String(shopifyOrderId),
      hpStatus,
      trackingNumber,
      carrier,
      lastError,
      incrementRetry
    ]
  );
}

async function markSupplierOrderFulfilled(
  shopifyOrderId,
  trackingNumber,
  carrier
) {
  await db.query(
    `
      UPDATE supplier_orders
      SET
        fulfilled = true,
        hp_status = 'shipped',
        tracking_number = $2,
        carrier = $3,
        last_error = NULL,
        last_polled_at = NOW(),
        updated_at = NOW()
      WHERE shopify_order_id = $1
    `,
    [
      String(shopifyOrderId),
      trackingNumber || null,
      carrier || null
    ]
  );
}

// -------------------------------------------------------
// Shopify webhook verification
// -------------------------------------------------------

async function verifyShopifyHmac(req, rawBody) {
  const secret =
    process.env.SHOPIFY_WEBHOOK_SECRET || '';

  const header =
    req.get('X-Shopify-Hmac-Sha256') || '';

  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const a = Buffer.from(header, 'utf8');
  const b = Buffer.from(digest, 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

// -------------------------------------------------------
// Shipping mapping
// -------------------------------------------------------

function shipCodeFor(order) {
  const title =
    (
      order.shipping_lines?.[0]?.title ||
      ''
    )
      .toLowerCase()
      .trim();

  const map = {
    'standard': 'P009',
    'usps priority': 'P002',
    'priority mail': 'P002',
    'fedex ground': 'F006',
    'ground': 'F006',
    'pickup': 'PICKUP',
    'local pickup': 'PICKUP'
  };

  return (
    map[title] ||
    process.env.HP_DEFAULT_SHIP ||
    'RTSHOP'
  );
}

// -------------------------------------------------------
// HP reference
// -------------------------------------------------------

function hpReferenceFor(order) {
  const forcedRef =
    /\bHPREF:\s*([A-Z0-9#-]+)/i.exec(
      order.note || ''
    )?.[1] || null;

  return (
    forcedRef ||
    String(order.name || order.id)
      .replace(/^#/, '')
      .toUpperCase()
  );
}

// -------------------------------------------------------
// Honey's Place XML
// -------------------------------------------------------

function buildHpOrderXml(order) {
  const shipping =
    order.shipping_address ||
    order.billing_address ||
    {};

  const items =
    (order.line_items || [])
      .filter(li => li.sku);

  const reference =
    hpReferenceFor(order);

  const xmlObj = {
    HPEnvelope: {
      account: process.env.HP_ACCOUNT,
      password: process.env.HP_TOKEN,

      order: {
        reference,

        shipby:
          shipCodeFor(order),

        date:
          new Date(
            order.created_at ||
            Date.now()
          )
            .toISOString()
            .slice(0, 10),

        items: {
          item:
            items.map(li => ({
              sku: li.sku,
              qty: li.quantity
            }))
        },

        last:
          shipping.last_name || '',

        first:
          shipping.first_name || '',

        address1:
          shipping.address1 || '',

        address2:
          shipping.address2 || '',

        city:
          shipping.city || '',

        state:
          shipping.province_code ||
          shipping.province ||
          '',

        zip:
          shipping.zip || '',

        country:
          shipping.country_code ||
          shipping.country ||
          'US',

        phone:
          shipping.phone ||
          order.phone ||
          '',

        emailaddress:
          order.email || '',

        instructions:
          (
            order.note || ''
          ).substring(0, 250)
      }
    }
  };

  return create(xmlObj).end({
    prettyPrint: false,
    declaration: {
      encoding: 'UTF-8'
    }
  });
}

function parseHpXmlToObject(xmlString) {
  try {
    const doc =
      create(xmlString);

    return doc.end({
      format: 'object'
    });
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------
// Honey's Place HTTP helpers
// -------------------------------------------------------

async function hpPost(xmlBody) {
  const body =
    'xmldata=' +
    encodeURIComponent(xmlBody);

  const res =
    await axios.post(
      'https://www.honeysplace.com/ws/',
      body,
      {
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',

          'Accept':
            'text/xml,application/xml;q=0.9,*/*;q=0.8',

          'User-Agent':
            'lovemart-hp-automation/1.0 (+https://lovemartco.com)'
        },

        timeout: 20000,
        maxRedirects: 0,

        validateStatus:
          () => true
      }
    );

  if (res.status !== 200) {
    const err =
      new Error(
        `HP POST failed with status ${res.status}`
      );

    err.response = res;

    throw err;
  }

  return res.data;
}

async function submitToHoney(xmlBody) {
  const data =
    await hpPost(xmlBody);

  const obj =
    parseHpXmlToObject(data);

  const env =
    obj?.HPEnvelope;

  return env
    ? {
        code:
          env.code ?? null,

        reference:
          env.reference ?? null,

        raw:
          data
      }
    : undefined;
}

// -------------------------------------------------------
// HP order status
// -------------------------------------------------------

async function hpOrderStatus(reference) {
  const queryXml =
    create({
      HPEnvelope: {
        account:
          process.env.HP_ACCOUNT,

        password:
          process.env.HP_TOKEN,

        orderstatus:
          String(reference)
      }
    }).end({
      prettyPrint: false,

      declaration: {
        encoding: 'UTF-8'
      }
    });

  const res =
    await axios.get(
      'https://www.honeysplace.com/ws/',
      {
        params: {
          xmldata:
            queryXml
        },

        headers: {
          'Accept':
            'text/xml,application/xml;q=0.9,*/*;q=0.8',

          'User-Agent':
            'curl/8.5.0',

          'Accept-Language':
            'en-US,en;q=0.9',

          'Referer':
            'https://www.honeysplace.com/',

          'Origin':
            'https://www.honeysplace.com'
        },

        timeout:
          20000,

        maxRedirects:
          0,

        validateStatus:
          () => true
      }
    );

  if (res.status !== 200) {
    const snippet =
      typeof res.data === 'string'
        ? res.data.slice(0, 300)
        : JSON.stringify(
            res.data
          ).slice(0, 300);

    const err =
      new Error(
        `HP GET failed with status ${res.status}: ${snippet}`
      );

    err.response =
      res;

    throw err;
  }

  const obj =
    parseHpXmlToObject(
      res.data
    );

  return (
    obj?.HPEnvelope ||
    {}
  );
}

// -------------------------------------------------------
// Shopify fulfillment
// -------------------------------------------------------

async function createShopifyFulfillment(
  orderId,
  {
    number,
    carrier
  }
) {
  const shopDomain =
    process.env
      .SHOPIFY_STORE_DOMAIN;

  const adminToken =
    process.env
      .SHOPIFY_ADMIN_TOKEN;

  const listUrl =
    `https://${shopDomain}` +
    `/admin/api/2026-07/orders/` +
    `${orderId}/fulfillment_orders.json`;

  const {
    data: listData
  } =
    await axios.get(
      listUrl,
      {
        headers: {
          'X-Shopify-Access-Token':
            adminToken
        }
      }
    );

  const fOrder =
    listData
      .fulfillment_orders
      ?.find(
        fo =>
          fo.status ===
            'open' &&
          (
            fo.supported_actions ||
            []
          ).includes(
            'create_fulfillment'
          )
      );

  if (!fOrder) {
    log(
      'No open fulfillment order available for',
      orderId
    );

    return false;
  }

  const lineItems =
    (
      fOrder.line_items ||
      []
    )
      .filter(
        li =>
          Number(
            li.fulfillable_quantity
          ) > 0
      )
      .map(
        li => ({
          id:
            li.id,

          quantity:
            li.fulfillable_quantity
        })
      );

  if (!lineItems.length) {
    log(
      'No fulfillable line items available for',
      orderId
    );

    return false;
  }

  const fulfillmentUrl =
    `https://${shopDomain}` +
    `/admin/api/2026-07/fulfillments.json`;

  const payload = {
    fulfillment: {
      message:
        "Fulfilled by Honey's Place",

      notify_customer:
        true,

      tracking_info: {
        number,
        company:
          carrier || '',
        url: ''
      },

      line_items_by_fulfillment_order:
        [
          {
            fulfillment_order_id:
              fOrder.id,

            fulfillment_order_line_items:
              lineItems
          }
        ]
    }
  };

  await axios.post(
    fulfillmentUrl,
    payload,
    {
      headers: {
        'X-Shopify-Access-Token':
          adminToken,

        'Content-Type':
          'application/json'
      }
    }
  );

  log(
    `Shopify fulfillment created for order ${orderId} with tracking ${number}`
  );

  return true;
}

// -------------------------------------------------------
// Poll Honey's Place statuses
// -------------------------------------------------------

async function pollHpStatuses() {
  const entries =
    await getPendingSupplierOrders();

  if (!entries.length) {
    return;
  }

  for (const info of entries) {
    const shopifyOrderId =
      String(
        info.shopify_order_id
      );

    const hpReference =
      String(
        info.hp_reference
      );

    try {
      const statusObj =
        await hpOrderStatus(
          hpReference
        );

      const status =
        (
          statusObj.status ||
          ''
        )
          .toLowerCase()
          .trim();

      const tracking =
        statusObj.trackingnumber1 ||
        '';

      const carrier =
        statusObj.shipagent ||
        '';

      await updateSupplierPollStatus(
        shopifyOrderId,
        {
          hpStatus:
            status ||
            null,

          trackingNumber:
            tracking ||
            null,

          carrier:
            carrier ||
            null,

          lastError:
            null,

          incrementRetry:
            false
        }
      );

      if (status === 'shipped') {
        if (!tracking) {
          log(
            `Order ${shopifyOrderId} is shipped at HP but has no tracking number yet`
          );

          continue;
        }

        const created =
          await createShopifyFulfillment(
            shopifyOrderId,
            {
              number:
                tracking,

              carrier
            }
          );

        if (created) {
          await markSupplierOrderFulfilled(
            shopifyOrderId,
            tracking,
            carrier
          );

          log(
            `Order ${shopifyOrderId} fulfilled. Tracking: ${tracking} (${carrier})`
          );
        } else {
          await updateSupplierPollStatus(
            shopifyOrderId,
            {
              hpStatus:
                status,

              trackingNumber:
                tracking,

              carrier,

              lastError:
                'Shopify fulfillment was not created because no open fulfillable order was available.',

              incrementRetry:
                true
            }
          );

          log(
            `Order ${shopifyOrderId} shipped at HP but Shopify fulfillment was not created`
          );
        }
      } else {
        log(
          `Order ${shopifyOrderId} still ${status || 'not yet shipped'}`
        );
      }
    } catch (err) {
      const httpStatus =
        err.response?.status;

      const snippetRaw =
        err.response?.data;

      const snippet =
        typeof snippetRaw ===
        'string'
          ? snippetRaw.slice(
              0,
              300
            )
          : JSON.stringify(
              snippetRaw ||
              ''
            ).slice(
              0,
              300
            );

      const errorMessage =
        [
          httpStatus ||
            err?.message ||
            'Unknown error',

          snippet
        ]
          .filter(Boolean)
          .join(' - ')
          .slice(0, 1000);

      try {
        await updateSupplierPollStatus(
          shopifyOrderId,
          {
            lastError:
              errorMessage,

            incrementRetry:
              true
          }
        );
      } catch (dbErr) {
        log(
          'Database error while recording poll failure for',
          shopifyOrderId,
          '-',
          dbErr?.message ||
            dbErr
        );
      }

      log(
        'Polling error for',
        shopifyOrderId,
        '-',
        errorMessage
      );
    }
  }
}

// -------------------------------------------------------
// Routes
// -------------------------------------------------------

app.get(
  '/',
  (_req, res) =>
    res.send(
      "Honey's Place Automation running"
    )
);

// -------------------------------------------------------
// Shopify paid-order webhook
// -------------------------------------------------------

app.post(
  '/webhooks/shopify/orders-paid',
  async (req, res) => {
    try {
      const rawBody =
        await getRawBody(req);

      const ok =
        await verifyShopifyHmac(
          req,
          rawBody
        );

      if (!ok) {
        log(
          'Invalid Shopify HMAC'
        );

        return res
          .status(401)
          .send(
            'Invalid HMAC'
          );
      }

      const order =
        JSON.parse(
          rawBody.toString(
            'utf8'
          )
        );

      const lineItems =
        order.line_items ||
        [];

      // Do not send a partial supplier order.
      //
      // Every Shopify line item must have a SKU.
      // Otherwise HP could receive only part of
      // the customer's order.
      const allItemsHaveSku =
        lineItems.length > 0 &&
        lineItems.every(
          li =>
            typeof li.sku ===
              'string' &&
            li.sku.trim() !==
              ''
        );

      if (!allItemsHaveSku) {
        log(
          'Skipping order because one or more line items are missing SKUs',
          order.id
        );

        return res.sendStatus(
          200
        );
      }

      // Determine the exact HP reference before
      // contacting Honey's Place.
      const expectedHpReference =
        hpReferenceFor(
          order
        );

      // ATOMIC ORDER RESERVATION
      //
      // PostgreSQL's UNIQUE constraint on
      // shopify_order_id guarantees that only
      // one webhook request can successfully
      // reserve this Shopify order.
      const reservationCreated =
        await reserveSupplierOrder(
          order.id,
          expectedHpReference
        );

      if (!reservationCreated) {
        log(
          'Skipping duplicate Shopify webhook for order',
          order.id
        );

        return res.sendStatus(
          200
        );
      }

      log(
        'Reserved Shopify order',
        order.id,
        'with HP reference',
        expectedHpReference
      );

      const xml =
        buildHpOrderXml(
          order
        );

      try {
        const result =
          await submitToHoney(
            xml
          );

        if (
          !result ||
          result.code !==
            '100'
        ) {
          const errorMessage =
            result?.raw
              ? String(
                  result.raw
                ).slice(
                  0,
                  1000
                )
              : 'Honey\'s Place returned an invalid or unsuccessful order response.';

          await markSupplierSubmissionError(
            order.id,
            errorMessage
          );

          log(
            'HP submission failed for',
            order.id,
            'response:',
            result?.raw ||
              result
          );

          return res.sendStatus(
            200
          );
        }

        const returnedReference =
          result.reference ||
          expectedHpReference;

        await markSupplierOrderSubmitted(
          order.id,
          returnedReference
        );

        log(
          'Submitted order',
          order.id,
          'to HP with reference',
          returnedReference
        );

        return res.sendStatus(
          200
        );
      } catch (err) {
        const status =
          err.response?.status;

        const snippet =
          err.response?.data
            ? String(
                err.response.data
              ).slice(
                0,
                300
              )
            : '';

        const errorMessage =
          [
            status ||
              err?.message ||
              'Unknown submission error',

            snippet
          ]
            .filter(Boolean)
            .join(' - ')
            .slice(0, 1000);

        try {
          await markSupplierSubmissionError(
            order.id,
            errorMessage
          );
        } catch (dbErr) {
          log(
            'Database error while recording HP submission failure for',
            order.id,
            '-',
            dbErr?.message ||
              dbErr
          );
        }

        log(
          'Error submitting to HP:',
          errorMessage
        );

        // Returning 500 allows Shopify to retry
        // delivery of the webhook.
        //
        // The atomic database reservation prevents
        // that retry from creating a duplicate HP order.
        return res.sendStatus(
          500
        );
      }
    } catch (err) {
      log(
        'Webhook error:',
        err?.message ||
          err
      );

      return res.sendStatus(
        500
      );
    }
  }
);

// -------------------------------------------------------
// Start server
// -------------------------------------------------------

const port =
  Number(
    process.env.PORT ||
      3000
  );

app.listen(
  port,
  async () => {
    log(
      `HP Automation listening on port ${port}`
    );

    try {
      await db.query(
        'SELECT 1'
      );

      log(
        'PostgreSQL connection verified'
      );
    } catch (err) {
      log(
        'PostgreSQL connection FAILED:',
        err?.message ||
          err
      );
    }
  }
);

// -------------------------------------------------------
// Polling interval
// -------------------------------------------------------

const intervalMinutes =
  Math.max(
    1,
    parseInt(
      process.env
        .POLL_INTERVAL_MINUTES ||
        '15',
      10
    )
  );

setInterval(
  () => {
    pollHpStatuses().catch(
      e =>
        log(
          'Polling error (interval):',
          e?.message ||
            e
        )
    );
  },

  intervalMinutes *
    60 *
    1000
);

// -------------------------------------------------------
// Initial post-start poll
// -------------------------------------------------------
//
// Pending orders live in PostgreSQL, so every
// Render restart automatically resumes polling.

setTimeout(
  () => {
    pollHpStatuses().catch(
      e =>
        log(
          'Initial poll error:',
          e?.message ||
            e
        )
    );
  },

  30 * 1000
);
