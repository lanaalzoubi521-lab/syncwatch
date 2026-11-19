// SyncWatch engine: replays the sync, reconciles both systems, and detects failures
// that never raise an error in the workflow's own run log.
import { GO_LIVE, NOW, SECRET_PATTERNS } from './data.js';

export const BUGGY = { filterField: 'CreatedDateTime', limit: 50, writeBack: false, secretsInline: true };

const priceAt = (p, t) => (t >= p.modified ? p.price : p._price0);

// Replays every scheduled run since go-live with a given workflow configuration.
export function replay(world, config) {
  const goLive = Date.parse(GO_LIVE);
  const shop = new Map(world.shopInitial.map(s => [s.sku, { ...s }]));
  const runs = [];
  const orders = [];
  let last = goLive;
  const events = [...world.runsAt.map(t => ({ t, kind: 'run' })), ...world.orders.map(o => ({ t: o.placed, kind: 'order', o }))].sort((a, b) => a.t - b.t);
  for (const ev of events) {
    if (ev.kind === 'run') {
      const t = ev.t;
      let cand;
      if (config.filterField === 'CreatedDateTime') cand = world.erp.filter(p => p.created >= goLive && p.created <= t).sort((a, b) => a.created - b.created); // fixed date, wrong field, API returns oldest first
      else cand = world.erp.filter(p => (p.modified > last && p.modified <= t) || (p.created > last && p.created <= t));
      const batch = config.limit ? cand.slice(0, config.limit) : cand;
      for (const p of batch) shop.set(p.sku, { sku: p.sku, title: p.name, price: priceAt(p, t), inventory: t >= p.modified ? p.onHand : p._onHand0 });
      runs.push({ at: t, fetched: cand.length, processed: batch.length, status: 'success' });
      last = t;
    } else {
      const lines = ev.o.lines.filter(l => shop.has(l.sku)).map(l => ({ ...l, paid: shop.get(l.sku).price }));
      if (lines.length) orders.push({ ...ev.o, lines });
    }
  }
  return { shop, runs, orders };
}

export function scanSecrets(workflow) {
  const hits = [];
  for (const node of workflow.nodes) {
    const text = JSON.stringify(node.parameters);
    for (const p of SECRET_PATTERNS) if (p.re.test(text)) hits.push({ node: node.name, pattern: p.name, sample: text.match(p.re)[0].slice(0, 18) + '…' });
  }
  return hits;
}

export function reconcile(world, state, config) {
  const erp = world.erp;
  const missing = erp.filter(p => !state.shop.has(p.sku));
  const priceDrift = [], stockDrift = [];
  for (const p of erp) {
    const s = state.shop.get(p.sku); if (!s) continue;
    if (s.price !== p.price) priceDrift.push({ sku: p.sku, name: p.name, erp: p.price, shop: s.price, created: p.created, modified: p.modified });
    if (s.inventory !== p.onHand) stockDrift.push({ sku: p.sku, name: p.name, erp: p.onHand, shop: s.inventory, created: p.created, modified: p.modified });
  }
  const oversell = stockDrift.filter(d => d.shop > d.erp);
  const oversellUnits = oversell.reduce((a, d) => a + d.shop - d.erp, 0);
  const oversellValue = oversell.reduce((a, d) => a + (d.shop - d.erp) * erp.find(p => p.sku === d.sku).price, 0);
  let underpriced = 0, underpricedLines = 0, orderValue = 0;
  for (const o of state.orders) for (const l of o.lines) {
    const p = erp.find(x => x.sku === l.sku);
    const should = priceAt(p, o.placed);
    orderValue += l.paid * l.qty;
    if (should > l.paid) { underpriced += (should - l.paid) * l.qty; underpricedLines++; }
  }
  const inErp = config.writeBack ? state.orders.length : 0;
  return {
    erpCount: erp.length, shopCount: state.shop.size, missing, priceDrift, stockDrift,
    oversellSkus: oversell.length, oversellUnits, oversellValue,
    underpriced, underpricedLines, orders: state.orders.length, ordersInErp: inErp, orderValue,
    missingValue: missing.reduce((a, p) => a + p.price * p.onHand, 0),
  };
}

// Each detector looks only at evidence a monitor can see: the run log, both systems, and the workflow JSON.
export function detect(world, workflow, config) {
  const state = replay(world, config);
  const rec = reconcile(world, state, config);
  const goLive = Date.parse(GO_LIVE);
  const findings = [];
  const runs = state.runs;
  const errors = runs.filter(r => r.status !== 'success').length;

  // 1. A cap that silently drops records
  const capped = runs.filter(r => r.processed < r.fetched);
  if (capped.length && rec.missing.length) {
    const cap = Math.max(...runs.map(r => r.processed));
    findings.push({
      id: 'limit', title: `${rec.missing.length} products never reached the store`,
      lede: `Since ${new Date(capped[0].at).toISOString().slice(0, 10)}, every run has processed exactly ${cap} items while the ERP query returned up to ${Math.max(...runs.map(r => r.fetched))}. The rest were dropped without an error.`,
      cause: `A Limit node set to ${cap} is still in the workflow. Its note says it was for testing.`,
      evidence: [
        ['Runs capped at ' + cap, `${capped.length} of ${runs.length}`],
        ['ERP products missing in Shopify', String(rec.missing.length)],
        ['Their stock value, not for sale', aed(rec.missingValue)],
      ],
      sample: rec.missing.slice(0, 5).map(p => [p.sku, p.name, 'not in Shopify']),
      fix: { label: 'Remove the Limit node', apply: c => ({ ...c, limit: null }),
        before: '{ "name": "Limit", "type": "n8n-nodes-base.limit", "parameters": { "maxItems": 50 } }', after: '// node removed' },
    });
  }

  // 2. A filter on the wrong date field: edits to existing products never sync
  const stale = [...new Set([...rec.priceDrift, ...rec.stockDrift].map(d => d.sku))];
  const staleOld = [...rec.priceDrift, ...rec.stockDrift].filter(d => d.created < goLive && d.modified > goLive);
  if (stale.length && staleOld.length / ([...rec.priceDrift, ...rec.stockDrift].length) > 0.9) {
    findings.push({
      id: 'filter', title: `${stale.length} products show the wrong price or stock`,
      lede: `All of them existed before go-live and were edited after it. Products created later sync fine. The query only ever asks for new products.`,
      cause: `The ERP request filters on CreatedDateTime with a fixed date. Edits change ModifiedDateTime, so they are never fetched.`,
      evidence: [
        ['Price differs from ERP', String(rec.priceDrift.length)],
        ['Stock differs from ERP', String(rec.stockDrift.length)],
        ['Store shows more stock than exists', `${rec.oversellUnits} units on ${rec.oversellSkus} products, ${aed(rec.oversellValue)}`],
        ['Sold below the ERP price', `${aed(rec.underpriced)} on ${rec.underpricedLines} order lines`],
      ],
      sample: rec.priceDrift.slice(0, 5).map(d => [d.sku, d.name, `${aed(d.shop)} in store · ${aed(d.erp)} in ERP`]),
      fix: { label: 'Filter on ModifiedDateTime since the last run', apply: c => ({ ...c, filterField: 'ModifiedDateTime' }),
        before: '"$filter": "CreatedDateTime ge 2026-10-01T00:00:00Z"', after: '"$filter": "ModifiedDateTime gt {{ $json.lastRunAt }}"' },
    });
  }

  // 3. No write-back: orders never reach finance
  if (!config.writeBack && rec.orders) {
    findings.push({
      id: 'writeback', title: `${rec.orders} store orders are missing in the ERP`,
      lede: `The workflow only moves data one way. Every Shopify order since go-live exists in the store and nowhere in finance.`,
      cause: 'There is no step that creates a sales order in Dynamics 365 when Shopify receives one.',
      evidence: [
        ['Shopify orders since go-live', String(rec.orders)],
        ['Matching ERP sales orders', '0'],
        ['Order value outside the books', aed(rec.orderValue)],
      ],
      sample: state.orders.slice(-5).reverse().map(o => [o.id, new Date(o.placed).toISOString().slice(0, 10), 'no ERP sales order']),
      fix: { label: 'Add order write-back to the ERP', apply: c => ({ ...c, writeBack: true }),
        before: '// no order flow', after: '{ "name": "Create D365 sales order", "type": "n8n-nodes-base.httpRequest",\n  "parameters": { "url": ".../data/SalesOrderHeadersV2", "method": "POST" } }' },
    });
  }

  // 4. Credentials stored in plain text in the workflow
  const secrets = config.secretsInline ? scanSecrets(workflow) : [];
  if (secrets.length) {
    findings.push({
      id: 'secret', title: 'An ERP access token sits in plain text in the workflow',
      lede: 'Anyone who can open or export this workflow can read it. It also travels into every backup and every copy shared for support.',
      cause: `The Authorization header in "${secrets[0].node}" holds the token directly instead of using n8n's credential store.`,
      evidence: secrets.map(s => [s.pattern, `${s.node}: ${s.sample}`]),
      sample: [],
      fix: { label: 'Move the token to the credential store', apply: c => ({ ...c, secretsInline: false }),
        before: '"value": "Bearer eyJ0eXAiOiJKV1Qi…"', after: '"authentication": "predefinedCredentialType",\n"nodeCredentialType": "microsoftDynamicsOAuth2Api"' },
    });
  }

  return { state, rec, findings, runs, errors };
}

export const aed = v => 'AED ' + Math.round(v).toLocaleString('en-US');
export { NOW, GO_LIVE };
