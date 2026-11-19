// Demo world: Raml Home, a fictional Dubai homeware retailer.
// ERP: Microsoft Dynamics 365 Finance & Operations (released products, on-hand, sales orders).
// Store: Shopify. Sync: an n8n workflow that went live on 1 Oct 2026 and has reported "Success" ever since.

export const GO_LIVE = '2026-10-01T00:00:00Z';
export const NOW = '2026-11-19T06:00:00Z';

const CATS = [
  ['LN', 'Linen', ['throw', 'pillowcase set', 'duvet cover', 'table runner', 'napkin set']],
  ['CR', 'Ceramic', ['vase', 'serving bowl', 'mug set', 'planter', 'dinner plate set']],
  ['OK', 'Oak', ['side table', 'stool', 'shelf', 'tray', 'bench']],
  ['RT', 'Rattan', ['basket set', 'lamp shade', 'mirror frame', 'chair', 'storage box']],
  ['BR', 'Brass', ['candle holder', 'tray', 'bowl', 'hook set', 'frame']],
  ['WL', 'Wool', ['rug 160x230', 'rug 200x300', 'cushion', 'pouf', 'blanket']],
];
const TONES = ['sand', 'clay', 'ivory', 'olive', 'charcoal', 'dune', 'pearl', 'smoke'];

function rng(seed) { let s = seed; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); }
const iso = ms => new Date(ms).toISOString().replace('.000', '');

export function buildWorld() {
  const r = rng(11);
  const goLive = Date.parse(GO_LIVE), now = Date.parse(NOW);
  const erp = [];
  let n = 0;
  for (const [code, mat, kinds] of CATS) for (const kind of kinds) for (const tone of TONES) {
    if (r() < 0.12) continue;
    n++;
    const sku = `${code}-${String(1000 + n)}`;
    const preExisting = r() < 0.66;
    const created = preExisting ? goLive - (1 + Math.floor(r() * 400)) * 86400000 : Math.min(goLive + Math.floor(r() * 48) * 86400000 + 3600000 + Math.floor(r() * 20) * 3600000, now - 7 * 3600000);
    const price0 = Math.round((40 + r() * 860) / 5) * 5;
    const stock0 = Math.floor(r() * 60);
    erp.push({ sku, name: `${mat} ${kind}, ${tone}`, created, modified: created, price: price0, onHand: stock0, _price0: price0, _onHand0: stock0 });
  }
  // Changes in the ERP since go-live: price revisions and stock movements on existing products.
  for (const p of erp) {
    if (p.created < goLive && r() < 0.55) {
      const m = goLive + Math.floor(r() * 49) * 86400000 + Math.floor(r() * 23) * 3600000;
      if (r() < 0.45) p.price = Math.round(p.price * (1 + (r() < 0.8 ? 0.08 + r() * 0.12 : -0.1)) / 5) * 5;
      p.onHand = Math.max(0, p.onHand - 1 - Math.floor(r() * 9));
      p.modified = Math.min(m, now - 7 * 3600000);
    }
  }
  erp.sort((a, b) => a.sku.localeCompare(b.sku));

  // Shopify as it was at go-live: the initial import of every product that existed then.
  const shopInitial = erp.filter(p => p.created < goLive).map(p => ({ sku: p.sku, title: p.name, price: p._price0, inventory: p._onHand0 }));

  // Orders placed on Shopify since go-live, priced at whatever Shopify showed.
  const orders = [];
  const runsAt = [];
  for (let t = goLive + 2 * 3600000; t < now; t += 6 * 3600000) runsAt.push(t);
  for (let i = 0; i < 186; i++) {
    const t = goLive + Math.floor(r() * (now - goLive - 7200000));
    const k = 1 + Math.floor(r() * 3);
    const lines = [];
    for (let j = 0; j < k; j++) {
      const p = erp[Math.floor(r() * erp.length)];
      if (p.created > t || lines.some(l => l.sku === p.sku)) continue;
      lines.push({ sku: p.sku, qty: 1 + Math.floor(r() * 3) });
    }
    if (lines.length) orders.push({ id: `#${4100 + i}`, placed: t, lines });
  }
  orders.sort((a, b) => a.placed - b.placed);
  orders.forEach((o, i) => (o.id = `#${4101 + i}`));
  return { erp, shopInitial, orders, runsAt };
}

// The workflow as exported from n8n (trimmed to the nodes that matter).
export function buggyWorkflow() {
  return {
    name: 'D365 F&O to Shopify - product sync',
    settings: {},
    nodes: [
      { name: 'Every 6 hours', type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } } },
      { name: 'Get released products', type: 'n8n-nodes-base.httpRequest', parameters: {
        url: 'https://raml.operations.dynamics.com/data/ReleasedProductsV2',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.DEMO-TOKEN-NOT-REAL' }] },
        sendQuery: true, queryParameters: { parameters: [{ name: '$filter', value: 'CreatedDateTime ge 2026-10-01T00:00:00Z' }] },
        options: {} } },
      { name: 'Limit', type: 'n8n-nodes-base.limit', parameters: { maxItems: 50 }, notes: 'testing, remove before go-live' },
      { name: 'Upsert Shopify product', type: 'n8n-nodes-base.shopify', parameters: { resource: 'product', operation: 'update' }, onError: 'continueRegularOutput' },
    ],
  };
}

export const SECRET_PATTERNS = [
  { name: 'Bearer token in a header', re: /Bearer\s+[A-Za-z0-9\-_.]{20,}/ },
  { name: 'Shopify access token', re: /shpat_[a-f0-9]{20,}/ },
  { name: 'Client secret', re: /client_secret["']?\s*[:=]\s*["'][^"']{8,}/i },
];
