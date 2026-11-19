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
      let drift = 0;
      for (const p of world.erp) {
        if (p.created > t) continue;
        const sh = shop.get(p.sku), price = priceAt(p, t), stock = t >= p.modified ? p.onHand : p._onHand0;
        if (!sh || sh.price !== price || sh.inventory !== stock) drift++;
      }
      runs.push({ at: t, fetched: cand.length, processed: batch.length, status: 'success', drift });
      last = t;
    } else {
      const lines = ev.o.lines.filter(l => shop.has(l.sku)).map(l => ({ ...l, paid: shop.get(l.sku).price }));
      if (lines.length) orders.push({ ...ev.o, lines });
    }
  }
  return { shop, runs, orders };
}

// Secret scan over the whole workflow: every node (parameters, notes, headers, bodies, JSON strings
// inside parameters) and pinned data. Reports type, place and length; never any part of the value.
const SECRET_KEY = /^(authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|passwd|pwd|private[-_]?key)$/i;
const SECRET_VALUE = [
  ['Bearer token', /\bbearer\s+[A-Za-z0-9\-_.=]{16,}/i],
  ['Basic auth credentials', /\bbasic\s+[A-Za-z0-9+/=]{12,}/i],
  ['Shopify access token', /\bshpat_[a-f0-9]{16,}/i],
  ['API key', /\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/],
];
const isExpr = v => /^=|\{\{/.test(v);
export function findSecrets(root) {
  const hits = [];
  const walk = (v, path, place) => {
    if (v == null) return;
    if (typeof v === 'string') {
      if (/^\s*[{[]/.test(v)) { try { walk(JSON.parse(v), path, place); } catch {} }
      for (const [name, re] of SECRET_VALUE) { const m = v.match(re); if (m && !isExpr(v)) { hits.push({ place, path, pattern: name, length: m[0].length }); return; } }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']', place)); return; }
    if (typeof v === 'object') {
      // {name: 'Authorization', value: '...'} pairs, as n8n stores headers and query parameters
      const pair = typeof v.name === 'string' && typeof v.value === 'string' && SECRET_KEY.test(v.name.trim()) && v.value.length >= 8 && !isExpr(v.value);
      if (pair) hits.push({ place, path: path + '.' + v.name, pattern: (SECRET_VALUE.find(([, re]) => re.test(v.value)) || [`Value of "${v.name}"`])[0], length: v.value.length });
      for (const [k, x] of Object.entries(v)) {
        if (pair && k === 'value') continue;
        if (typeof x === 'string' && SECRET_KEY.test(k) && x.length >= 8 && !isExpr(x) && !SECRET_VALUE.some(([, re]) => re.test(x))) hits.push({ place, path: path + '.' + k, pattern: `Value of "${k}"`, length: x.length });
        else walk(x, path + '.' + k, place);
      }
    }
  };
  const nodes = Array.isArray(root?.nodes) ? root.nodes.filter(n => n && typeof n === 'object') : [];
  for (const n of nodes) walk({ parameters: n.parameters, notes: n.notes }, '', String(n.name || 'unnamed node'));
  if (root?.pinData) walk(root.pinData, 'pinData', 'Pinned test data');
  if (root?.staticData) walk(root.staticData, 'staticData', 'Static data');
  return hits;
}
export function scanSecrets(workflow) {
  return findSecrets(workflow).map(h => ({ node: h.place, pattern: h.pattern, length: h.length }));
}

// A copy of the workflow that is safe to show a language model: secrets blanked by key and by value,
// pinned and static data dropped, free text clipped.
export function redactWorkflow(wf) {
  const clip = s => (s.length > 120 ? s.slice(0, 120) + '…' : s);
  const scrub = (v, key = '') => {
    if (v == null) return v;
    if (typeof v === 'string') {
      if (SECRET_KEY.test(key) && !isExpr(v)) return '[REDACTED]';
      if (/^\s*[{[]/.test(v)) { try { return clip(JSON.stringify(scrub(JSON.parse(v)))); } catch {} }
      let out = v; for (const [, re] of SECRET_VALUE) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), '[REDACTED]');
      return clip(out);
    }
    if (Array.isArray(v)) return v.map(x => scrub(x, key));
    if (typeof v === 'object') {
      const o = {};
      const pairSecret = typeof v.name === 'string' && SECRET_KEY.test(v.name.trim());
      for (const [k, x] of Object.entries(v)) o[k] = pairSecret && k === 'value' ? '[REDACTED]' : scrub(x, k);
      return o;
    }
    return v;
  };
  const { pinData, staticData, ...rest } = wf || {};
  const out = scrub(rest);
  out.nodes = (Array.isArray(rest.nodes) ? rest.nodes : []).filter(n => n && typeof n === 'object').map(n => scrub(n));
  return out;
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
      evidence: secrets.map(s => [s.pattern, `in "${s.node}", ${s.length} characters, value hidden`]),
      sample: [],
      fix: { label: 'Move the token to the credential store', apply: c => ({ ...c, secretsInline: false }),
        before: '"value": "Bearer ••••••••••••"', after: '"authentication": "predefinedCredentialType",\n"nodeCredentialType": "microsoftDynamicsOAuth2Api"' },
    });
  }

  return { state, rec, findings, runs, errors };
}

// Workflow audit: static checks on an exported n8n workflow. Works on any workflow file.
export function lintWorkflow(wf) {
  const out = [];
  const nodes = Array.isArray(wf?.nodes) ? wf.nodes.filter(n => n && typeof n === 'object') : [];
  const txt = n => JSON.stringify(n.parameters || {});
  for (const s of scanSecrets(wf || {})) out.push({ id: 'secret', sev: 'high', node: s.node, title: 'Secret stored in plain text', detail: `${s.pattern} in "${s.node}" (${s.length} characters). Anyone who can open or export the workflow can read it.`, fix: "Move it to n8n's credential store and reference the credential." });
  for (const n of nodes) {
    const t = txt(n), type = String(n.type || '');
    if (type.endsWith('.limit')) out.push({ id: 'limit', sev: /test|debug|temp|remove/i.test(String(n.notes || '')) ? 'high' : 'medium', node: n.name, title: `Limit node caps every run at ${Number(n.parameters?.maxItems) || '?'} items`, detail: `Records past the cap are dropped without an error.${n.notes ? ` Node note: "${String(n.notes).slice(0, 80)}".` : ''}`, fix: 'Remove the node, or paginate and process every batch.' });
    if (/CreatedDateTime|createdDateTime|created_at/.test(t) && /(ge|gt|>=|>)\s*\d{4}-\d{2}-\d{2}/.test(t)) out.push({ id: 'filter', sev: 'high', node: n.name, title: 'Query filters on creation date with a fixed value', detail: 'Edits to existing records change the modified date, not the created date, so they are never fetched again.', fix: 'Filter on the modified date since the last successful run.' });
    else if (/\$filter|updated_at_min|modified/i.test(t) && /\d{4}-\d{2}-\d{2}T/.test(t) && !/\{\{/.test(t)) out.push({ id: 'fixeddate', sev: 'medium', node: n.name, title: 'Date filter is a fixed value', detail: 'A hard-coded date never moves forward, so the window grows or stays wrong.', fix: 'Use an expression based on the last run time.' });
    if (n.onError === 'continueRegularOutput' || n.continueOnFail === true) out.push({ id: 'swallow', sev: 'high', node: n.name, title: 'Errors are passed on as success', detail: `"${n.name}" continues on error, so a failed update still ends the run green.`, fix: 'Use "Continue (using error output)" and route failures to an alert, or stop the workflow.' });
    if (type.endsWith('.httpRequest') && /\/data\//.test(t) && !n.parameters?.options?.pagination) out.push({ id: 'paging', sev: 'medium', node: n.name, title: 'Reads only the first page of results', detail: 'OData endpoints return results in pages. Without pagination, large catalogues are cut off.', fix: 'Enable pagination on the HTTP Request node, following the @odata.nextLink.' });
    if (type.endsWith('.httpRequest') && !n.retryOnFail) out.push({ id: 'retry', sev: 'low', node: n.name, title: 'No retry on temporary failures', detail: 'A brief timeout fails the whole run.', fix: 'Turn on Retry On Fail with a short wait.' });
  }
  const hasErp = nodes.some(n => /dynamics\.com|\/data\//.test(txt(n)));
  const hasShop = nodes.some(n => /shopify/i.test(String(n.type)) || /myshopify\.com/.test(txt(n)));
  const writesErp = nodes.some(n => /dynamics\.com|\/data\//.test(txt(n)) && /"method":"(POST|PATCH|PUT)"/.test(txt(n)));
  if (hasErp && hasShop && !writesErp) out.push({ id: 'writeback', sev: 'high', node: '', title: 'No write-back to the ERP', detail: 'The workflow moves data one way. Store orders never become ERP sales orders.', fix: 'Add a step that creates a sales order in the ERP for each store order.' });
  if (!wf?.settings?.errorWorkflow && !nodes.some(n => String(n.type).endsWith('.errorTrigger'))) out.push({ id: 'noalert', sev: 'medium', node: '', title: 'Failures notify nobody', detail: 'No error workflow is set, so a failed run is only visible inside n8n.', fix: 'Set an error workflow that sends an email or Slack message.' });
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

// Reconciliation for real exports: ERP products vs store products, and optionally orders.
export function reconcileFiles({ erp = [], shop = [], shopOrders = [], erpOrders = [] }) {
  const key = v => String(v ?? '').trim().toUpperCase();
  const index = rows => { const m = new Map(), dup = new Set(); for (const r of rows) { const k = key(r.sku); if (!k) continue; if (m.has(k)) dup.add(k); m.set(k, { ...r, sku: k }); } return [m, [...dup]]; };
  const [byErp, dupErp] = index(erp), [byShop, dupShop] = index(shop);
  const missingInShop = [...byErp.values()].filter(r => !byShop.has(r.sku));
  const missingInErp = [...byShop.values()].filter(r => !byErp.has(r.sku));
  const priceDrift = [], stockDrift = [], unreadable = [];
  for (const e of byErp.values()) {
    const s = byShop.get(e.sku); if (!s) continue;
    if ((e.price == null) !== (s.price == null)) unreadable.push(e.sku);
    if (e.price != null && s.price != null && Math.abs(e.price - s.price) > 0.004) priceDrift.push({ sku: e.sku, name: e.name || s.name, erp: e.price, shop: s.price });
    if (e.stock != null && s.stock != null && e.stock !== s.stock) stockDrift.push({ sku: e.sku, name: e.name || s.name, erp: e.stock, shop: s.stock });
  }
  const oversell = stockDrift.filter(d => d.shop > d.erp);
  // Shopify order exports have one row per line item: one order, many rows.
  const orders = new Map(); for (const o of shopOrders) { const k = key(o.id).replace(/^#/, ''); if (k && !orders.has(k)) orders.set(k, o); }
  const refs = new Set(erpOrders.map(o => key(o.ref).replace(/^#/, '')));
  const unbooked = [...orders.entries()].filter(([k]) => !refs.has(k)).map(([, o]) => o);
  return { erpCount: byErp.size, shopCount: byShop.size, missingInShop, missingInErp, priceDrift, stockDrift, duplicates: { erp: dupErp, shop: dupShop }, unreadable,
    oversellSkus: oversell.length, oversellUnits: oversell.reduce((a, d) => a + d.shop - d.erp, 0),
    oversellValue: oversell.reduce((a, d) => a + (d.shop - d.erp) * (byErp.get(d.sku).price || 0), 0),
    orders: orders.size, unbooked, unbookedValue: unbooked.reduce((a, o) => a + (o.total || 0), 0) };
}

export const aed = v => 'AED ' + Math.round(v).toLocaleString('en-US');
export { NOW, GO_LIVE };
