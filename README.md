# LoveMart Co. → Honey's Place Order Automation

This project contains a small Node.js service that automates sending paid
Shopify orders to Honey's Place and updates the order in Shopify with the
tracking number once Honey's Place ships the order.  It removes the need to
manually submit XML payloads or manually create fulfillments in Shopify.

## How it works

1. **Webhook listener** – Shopify sends a webhook when an order is created or
   paid.  The service listens to `POST /webhooks/shopify/orders-paid`,
   verifies the webhook signature and extracts the order data.
2. **XML builder** – The order is converted into Honey's Place XML format,
   including only line items that have an SKU.  The default shipping code
   (e.g. `RTSHOP`) is applied unless you override it by mapping Shopify
   shipping titles in `shipCodeFor()` in `index.js`.
3. **Submit to Honey's Place** – The service posts the XML to
   `https://www.honeysplace.com/ws/`.  If the response code is `100` the order
   is accepted and the reference number is saved in an in‑memory store.
4. **Status polling** – A background job runs every `POLL_INTERVAL_MINUTES`
   minutes to call the Honey's Place **Order Status** API for all submitted
   orders that have not yet shipped.  When the order status changes to
   “Shipped” the service fetches the tracking number and carrier and then
   creates a fulfillment on Shopify.  Once fulfilled the order is removed
   from the polling queue.

### Important notes

* **Database** – This reference implementation keeps order references in
  memory.  If the service restarts all knowledge of submitted orders is lost.
  In a production environment you should replace the `orderStore` object in
  `index.js` with a persistent database (e.g. SQLite, PostgreSQL, DynamoDB).
* **Security** – Never commit your `.env` file with real secrets.  Use
  `.env.sample` as a template and create your own `.env` locally.
* **Testing** – Honey's Place treats any order whose reference starts with
  “TEST” as a test.  They will respond with a dummy tracking number
  (`123456789`) and will not actually ship the order.  You should place test
  orders first and check the logs to verify that orders are accepted and
  fulfilled correctly.

## Getting started

### Requirements

* Node.js 16 or later
* npm (comes with Node.js)

### Setup

1. **Clone or download** this directory on your deployment server.
2. Run `npm install` inside the `hp_automation` directory to install
   dependencies.
3. Copy `.env.sample` to `.env` and fill in the following values:
   * `SHOPIFY_WEBHOOK_SECRET` – The webhook signing secret from Shopify.
   * `SHOPIFY_STORE_DOMAIN` – Your store domain, e.g. `mystore.myshopify.com`.
   * `SHOPIFY_ADMIN_TOKEN` – Your private app's Admin API access token.
   * `HP_ACCOUNT` – Your Honey's Place account number.
   * `HP_TOKEN` – The API token (password) from Honey's Place.
   * (Optional) `HP_DEFAULT_SHIP` – Default shipping code; defaults to
     `RTSHOP` if left blank.
4. Start the service using `npm start`.  The server will listen on
   `http://localhost:3000` by default.
5. **Create a webhook in Shopify** that points to your server.  In Shopify
   admin go to **Settings → Notifications → Webhooks** and click **Create
   webhook**.  Choose the **Order paid** event and set the URL to
   `https://your-server-domain/webhooks/shopify/orders-paid`.  Copy the
   secret into your `.env` file.
6. **Deploy** the service to a hosting provider (e.g. Railway, Render,
   Fly.io, Vercel) using Node.js.  Make sure port 3000 is exposed or set
   `PORT` accordingly.
7. **Test** by placing a Shopify order whose name starts with “TEST”.  You
   should see logs indicating the order was submitted to Honey's Place and
   fulfilled with a dummy tracking number.  Once confirmed remove the `TEST`
   prefix for real orders.

## Customising shipping methods

In `index.js`, the function `shipCodeFor(order)` maps Shopify shipping titles
to Honey's Place codes.  You can extend this function to recognise your own
shipping titles.  For example:

```js
const map = {
  'express 2‑day': 'P002',
  'overnight': 'F002',
  'free shipping': 'RTSHOP'
};
```

If none of the map keys match the order's shipping title the default value
`HP_DEFAULT_SHIP` is used.

## Persisting order references

If you restart the service while there are still orders waiting for
fulfillment you will lose the references.  To prevent this you should save
the `orderStore` data to a persistent store (database or file) and load it on
startup.  For simplicity this example does not include database logic.