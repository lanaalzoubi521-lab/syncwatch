// SyncWatch: product UI.
const W = buildWorld();
const DEMO_FIX = { swallow: false, paging: false, retry: false, alert: false };
const S = { mode: 'demo', config: { ...BUGGY, swallow: true, paging: false, retry: false, alert: false }, files: null, incidents: [], audit: [], log: [], resolved: new Set(), view: 'overview', recFilter: 'bad', q: '' };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = n => Number(n).toLocaleString('en-US');
let sample = null, ctl = null;

// Demo workflow as it would look after the approved changes.
function demoWorkflow(c) {
  const wf = JSON.parse(JSON.stringify(buggyWorkflow()));
  const get = wf.nodes.find(n => n.name === 'Get released products');
  if (!c.limit) wf.nodes = wf.nodes.filter(n => n.name !== 'Limit');
  if (c.filterField === 'ModifiedDateTime') get.parameters.queryParameters.parameters[0].value = 'ModifiedDateTime gt {{ $json.lastRunAt }}';
  if (!c.secretsInline) { get.parameters.sendHeaders = false; delete get.parameters.headerParameters; get.parameters.authentication = 'predefinedCredentialType'; get.parameters.nodeCredentialType = 'microsoftDynamicsOAuth2Api'; }
  if (c.paging) get.parameters.options.pagination = { pagination: { paginationMode: 'responseContainsNextURL', nextURL: '={{ $response.body["@odata.nextLink"] }}' } };
  if (c.retry) get.retryOnFail = true;
  if (!c.swallow) wf.nodes.find(n => n.name === 'Upsert Shopify product').onError = 'continueErrorOutput';
  if (c.writeBack) wf.nodes.push({ name: 'Create D365 sales order', type: 'n8n-nodes-base.httpRequest', parameters: { method: 'POST', url: 'https://raml.operations.dynamics.com/data/SalesOrderHeadersV2' }, retryOnFail: true });
  if (c.alert) wf.settings.errorWorkflow = 'ops-alerts';
  return wf;
}
const LINT_FIX = { swallow: c => ({ ...c, swallow: false }), paging: c => ({ ...c, paging: true }), retry: c => ({ ...c, retry: true }), noalert: c => ({ ...c, alert: true }) };
const LINT_DIFF = {
  swallow: ['"onError": "continueRegularOutput"', '"onError": "continueErrorOutput"  // failures go to an alert branch'],
  paging: ['"options": {}', '"options": { "pagination": { "paginationMode": "responseContainsNextURL",\n  "nextURL": "={{ $response.body[\\"@odata.nextLink\\"] }}" } }'],
  retry: ['// no retry', '"retryOnFail": true'],
  noalert: ['"settings": {}', '"settings": { "errorWorkflow": "ops-alerts" }'],
};

function compute() {
  if (S.mode === 'demo') {
    const wf = demoWorkflow(S.config);
    const r = detect(W, wf, S.config);
    S.result = r; S.wf = wf; S.audit = lintWorkflow(wf);
    const covered = new Set(r.findings.map(f => f.id));
    S.incidents = [
      ...r.findings.map(f => ({ ...f, kind: 'incident', sev: 'high', fix: { ...f.fix, apply: f.fix.apply } })),
      ...S.audit.filter(a => !covered.has(a.id) && LINT_FIX[a.id]).map(a => ({ id: a.id, kind: 'risk', sev: a.sev, title: a.title, lede: a.detail, cause: a.detail, evidence: [['Node', a.node || 'Workflow settings'], ['Severity', a.sev]], sample: [], fix: { label: a.fix, before: LINT_DIFF[a.id][0], after: LINT_DIFF[a.id][1], apply: LINT_FIX[a.id] } })),
    ];
  } else {
    const F = S.files, rec = reconcileFiles(F);
    S.rec = rec; S.audit = F.wf ? lintWorkflow(F.wf) : []; S.wf = F.wf;
    const has = id => S.audit.find(a => a.id === id);
    const cause = (ids, fallback) => { const a = ids.map(has).find(Boolean); return a ? `${a.title}${a.node ? ` in "${a.node}"` : ''}. ${a.detail}` : fallback; };
    const inc = [];
    if (rec.missingInShop.length) inc.push({ id: 'missing', kind: 'incident', sev: 'high', title: `${rec.missingInShop.length} ERP products are not in the store`, lede: 'They exist in the ERP export and nowhere in the store export.', cause: cause(['limit', 'paging'], 'Upload the workflow file to find the cause.'), evidence: [['Products in ERP', fmt(rec.erpCount)], ['Products in store', fmt(rec.shopCount)], ['Missing in store', fmt(rec.missingInShop.length)]], sample: rec.missingInShop.slice(0, 6).map(p => [p.sku, p.name || '', 'not in store']), fix: { label: has('limit')?.fix || has('paging')?.fix || 'Check which records the sync fetches.' } });
    const driftN = new Set([...rec.priceDrift, ...rec.stockDrift].map(d => d.sku)).size;
    if (driftN) inc.push({ id: 'drift', kind: 'incident', sev: 'high', title: `${driftN} products show a different price or stock`, lede: 'The store and the ERP disagree on these products.', cause: cause(['filter', 'fixeddate', 'swallow'], 'Upload the workflow file to find the cause.'), evidence: [['Price differs', fmt(rec.priceDrift.length)], ['Stock differs', fmt(rec.stockDrift.length)], ['Store shows more stock than the ERP', `${fmt(rec.oversellUnits)} units on ${fmt(rec.oversellSkus)} products`]], sample: rec.priceDrift.slice(0, 6).map(d => [d.sku, d.name || '', `${d.shop} in store · ${d.erp} in ERP`]), fix: { label: has('filter')?.fix || has('fixeddate')?.fix || has('swallow')?.fix || 'Fetch every record modified since the last run.' } });
    if (rec.unbooked.length) inc.push({ id: 'orders', kind: 'incident', sev: 'high', title: `${rec.unbooked.length} store orders have no ERP sales order`, lede: 'These orders exist in the store export and are missing from the ERP sales orders.', cause: cause(['writeback'], 'No matching reference found in the ERP export.'), evidence: [['Store orders', fmt(rec.orders)], ['Without an ERP sales order', fmt(rec.unbooked.length)]], sample: rec.unbooked.slice(0, 6).map(o => [String(o.id), o.total != null ? String(o.total) : '', 'no ERP order']), fix: { label: has('writeback')?.fix || 'Create an ERP sales order for each store order.' } });
    if (rec.missingInErp.length) inc.push({ id: 'orphans', kind: 'incident', sev: 'medium', title: `${rec.missingInErp.length} store products do not exist in the ERP`, lede: 'Sold online but unknown to finance and the warehouse.', cause: 'Products created directly in the store, or SKUs changed in one system only.', evidence: [['Store-only products', fmt(rec.missingInErp.length)]], sample: rec.missingInErp.slice(0, 6).map(p => [p.sku, p.name || '', 'not in ERP']), fix: { label: 'Create them in the ERP or retire them from the store.' } });
    const dups = [...new Set([...rec.duplicates.erp, ...rec.duplicates.shop])];
    if (dups.length) inc.push({ id: 'dups', kind: 'incident', sev: 'medium', title: `${dups.length} SKUs appear more than once`, lede: 'The same SKU is on several rows of an export. Only the last row was compared, so these results may hide differences.', cause: 'Variants or duplicate records sharing one SKU.', evidence: [['In ERP export', fmt(rec.duplicates.erp.length)], ['In store export', fmt(rec.duplicates.shop.length)]], sample: dups.slice(0, 6).map(k => [k, '', 'duplicate']), fix: { label: 'Give every variant its own SKU, then export again.' } });
    if (rec.unreadable.length) inc.push({ id: 'unread', kind: 'incident', sev: 'medium', title: `${rec.unreadable.length} prices could not be read`, lede: 'A price is present on one side but not readable as a number, so drift could not be checked.', cause: 'Text in a price column.', evidence: [['Products affected', fmt(rec.unreadable.length)]], sample: rec.unreadable.slice(0, 6).map(k => [k, '', 'price not a number']), fix: { label: 'Export prices as plain numbers.' } });
    for (const a of S.audit) inc.push({ id: 'lint-' + a.id + a.node, kind: 'risk', sev: a.sev, title: a.title, lede: a.detail, cause: a.detail, evidence: [['Node', a.node || 'Workflow settings'], ['Severity', a.sev]], sample: [], fix: { label: a.fix } });
    S.incidents = inc.filter(i => !S.resolved.has(i.id));
  }
}

function nav(v) {
  S.view = v;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === v));
  document.querySelectorAll('.page').forEach(p => p.hidden = p.id !== 'pg-' + v);
  $('#crumb').textContent = { overview: 'Overview', incidents: 'Incidents', recon: 'Reconciliation', audit: 'Workflow audit', agent: 'Investigate', import: 'Connect data' }[v];
  render();
  document.body.classList.remove('nav-open');
}

function sevDot(s) { return `<span class="dot ${s}"></span>`; }

function render() {
  const demo = S.mode === 'demo';
  const inc = S.incidents.filter(i => i.kind === 'incident'), risks = S.incidents.filter(i => i.kind === 'risk');
  $('#src').textContent = demo ? 'Raml Home (demo)' : 'Your data';
  $('#src-meta').textContent = demo ? 'D365 F&O → Shopify · n8n' : [S.files.erp.length && `${fmt(S.files.erp.length)} ERP products`, S.files.shop.length && `${fmt(S.files.shop.length)} store products`].filter(Boolean).join(' · ');
  $('#n-inc').textContent = inc.length || ''; $('#n-risk').textContent = risks.length || '';
  // KPIs
  if (demo) {
    const r = S.result, rec = r.rec;
    $('#k1l').textContent = 'Workflow status'; $('#k1box').className = 'kpi ok';
    $('#k1').textContent = `${r.runs.length - r.errors}/${r.runs.length}`; $('#k1s').textContent = 'runs reported success';
    $('#k2').textContent = inc.length; $('#k2s').textContent = inc.length ? 'incidents the run log never showed' : 'no data incidents';
    $('#k3').textContent = fmt(new Set([...rec.priceDrift, ...rec.stockDrift].map(d => d.sku)).size + rec.missing.length); $('#k3s').textContent = `of ${fmt(rec.erpCount)} products out of sync`;
    $('#k4').textContent = `${fmt(rec.orders - rec.ordersInErp)}`; $('#k4s').textContent = `of ${fmt(rec.orders)} store orders not in the ERP`;
    $('#chartwrap').hidden = false; drawChart(r.runs);
  } else {
    const rec = S.rec;
    $('#k1l').textContent = 'Workflow audit'; $('#k1box').className = S.audit.some(a => a.sev === 'high') ? 'kpi bad' : 'kpi';
    $('#k1').textContent = S.files.wf ? `${S.audit.length}` : '—'; $('#k1s').textContent = S.files.wf ? 'workflow audit findings' : 'no workflow file';
    $('#k2').textContent = inc.length; $('#k2s').textContent = 'data incidents';
    $('#k3').textContent = fmt(new Set([...rec.priceDrift, ...rec.stockDrift].map(d => d.sku)).size + rec.missingInShop.length); $('#k3s').textContent = `of ${fmt(rec.erpCount)} ERP products out of sync`;
    $('#k4').textContent = rec.orders ? fmt(rec.unbooked.length) : '—'; $('#k4s').textContent = rec.orders ? `of ${fmt(rec.orders)} store orders not in the ERP` : 'no order files';
    $('#chartwrap').hidden = true;
  }
  $('#ov-inc').innerHTML = rows(S.incidents.slice(0, 6));
  $('#all-inc').innerHTML = rows(S.incidents) || `<tr><td colspan="4" class="emptyrow">No open incidents. Both systems agree.</td></tr>`;
  document.querySelectorAll('[data-inc]').forEach(tr => tr.onclick = () => openIncident(tr.dataset.inc));
  renderRecon(); renderAudit();
  $('#log').innerHTML = S.log.map(l => `<tr><td class="mono mute">${esc(l.time)}</td><td>${esc(l.text)}</td></tr>`).join('') || `<tr><td colspan="2" class="emptyrow">No changes approved yet.</td></tr>`;
}

function rows(list) {
  return list.map(i => `<tr data-inc="${esc(i.id)}"><td>${sevDot(i.sev)}</td><td><b>${esc(i.title)}</b><span class="sub">${esc(i.lede)}</span></td><td class="hide-s"><span class="tag ${i.kind}">${i.kind === 'incident' ? 'Data incident' : 'Workflow risk'}</span></td><td class="act mute">Open →</td></tr>`).join('');
}

function drawChart(runs) {
  const w = 1000, h = 180, n = runs.length, max = Math.max(1, ...runs.map(r => r.drift));
  const x = i => (i / (n - 1)) * w, y = v => h - 24 - (v / max) * (h - 44);
  const line = runs.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.drift).toFixed(1)}`).join('');
  const area = line + `L${w},${h - 24}L0,${h - 24}Z`;
  const ticks = runs.map((r, i) => `<rect x="${(x(i) - 1.4).toFixed(1)}" y="${h - 14}" width="2.8" height="10" rx="1" class="${r.status === 'success' ? 'ok' : 'bad'}"/>`).join('');
  const months = [...new Set(runs.map(r => new Date(r.at).toISOString().slice(0, 7)))].map(m => { const i = runs.findIndex(r => new Date(r.at).toISOString().startsWith(m)); return `<text x="${x(i) + 4}" y="12">${new Date(m + '-01').toLocaleString('en-US', { month: 'short' })}</text>`; }).join('');
  $('#chart').innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Runs reported success while records out of sync grew"><path d="${area}" class="area"/><path d="${line}" class="line"/>${ticks}</svg><div class="months">${months.replace(/<text x="([\d.]+)" y="12">([^<]+)<\/text>/g, (m, xx, t) => `<span style="left:${(xx / w) * 100}%">${t}</span>`)}</div>`;
  const last = runs[runs.length - 1];
  $('#chart-note').innerHTML = `<b>${fmt(last.drift)}</b> products out of sync after the latest run · every run reported success`;
}

function renderRecon() {
  let list = [];
  if (S.mode === 'demo') {
    const shop = S.result.state.shop;
    list = W.erp.map(p => { const s = shop.get(p.sku); return { sku: p.sku, name: p.name, ep: p.price, sp: s?.price, es: p.onHand, ss: s?.inventory, st: !s ? 'missing' : (s.price !== p.price || s.inventory !== p.onHand) ? 'drift' : 'ok' }; });
  } else {
    const shop = new Map(S.files.shop.map(r => [r.sku, r]));
    list = S.files.erp.map(p => { const s = shop.get(p.sku); return { sku: p.sku, name: p.name || s?.name, ep: p.price, sp: s?.price, es: p.stock, ss: s?.stock, st: !s ? 'missing' : ((p.price != null && s.price != null && Math.abs(p.price - s.price) > 0.004) || (p.stock != null && s.stock != null && p.stock !== s.stock)) ? 'drift' : 'ok' }; });
  }
  const q = S.q.toLowerCase();
  const counts = { all: list.length, bad: list.filter(r => r.st !== 'ok').length, ok: list.filter(r => r.st === 'ok').length };
  document.querySelectorAll('[data-rf]').forEach(b => { b.classList.toggle('on', b.dataset.rf === S.recFilter); b.querySelector('i').textContent = counts[b.dataset.rf]; });
  list = list.filter(r => (S.recFilter === 'all' || (S.recFilter === 'bad' ? r.st !== 'ok' : r.st === 'ok')) && (!q || (r.sku + ' ' + (r.name || '')).toLowerCase().includes(q))).slice(0, 400);
  const cell = (a, b) => a == null ? '<td class="num mute">—</td>' : `<td class="num ${b != null && a !== b ? 'diff' : ''}">${fmt(a)}</td>`;
  $('#rec-rows').innerHTML = list.map(r => `<tr><td class="mono">${esc(r.sku)}</td><td class="hide-s">${esc(r.name || '')}</td>${cell(r.ep)}${r.sp == null ? '<td class="num mute">—</td>' : cell(r.sp, r.ep)}${cell(r.es)}${r.ss == null ? '<td class="num mute">—</td>' : cell(r.ss, r.es)}<td><span class="st st-${r.st}">${{ ok: 'In sync', drift: 'Different', missing: 'Not in store' }[r.st]}</span></td></tr>`).join('') || `<tr><td colspan="7" class="emptyrow">Nothing to show.</td></tr>`;
}

function renderAudit() {
  $('#aud-rows').innerHTML = S.audit.map(a => `<tr><td>${sevDot(a.sev)}</td><td><b>${esc(a.title)}</b><span class="sub">${esc(a.detail)}</span></td><td class="mono mute hide-s">${esc(a.node || 'settings')}</td><td class="hide-s">${esc(a.fix)}</td></tr>`).join('') || `<tr><td colspan="4" class="emptyrow">${S.wf ? 'No findings. The workflow passes every check.' : 'Upload a workflow file on the Connect data page.'}</td></tr>`;
}

function drawer(html) { $('#dr-body').innerHTML = html; document.body.classList.add('dr-open'); }
function closeDrawer() { document.body.classList.remove('dr-open'); }

function openIncident(id) {
  const i = S.incidents.find(x => x.id === id); if (!i) return;
  const canApply = S.mode === 'demo' && i.fix.apply;
  drawer(`<div class="dr-k">${sevDot(i.sev)}<span class="tag ${i.kind}">${i.kind === 'incident' ? 'Data incident' : 'Workflow risk'}</span></div>
    <h3>${esc(i.title)}</h3><p class="dr-why">${esc(i.lede)}</p>
    <dl class="kv">${i.evidence.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${i.sample.length ? `<div class="sec">Examples</div><table class="mini"><tbody>${i.sample.map(r => `<tr>${r.map((c, j) => `<td class="${j === 0 ? 'mono' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
    <div class="sec">Root cause</div><p class="dr-p">${esc(i.cause)}</p>
    <div class="sec">Fix</div><p class="dr-p">${esc(i.fix.label)}</p>
    ${i.fix.before ? `<pre class="code b">${esc(i.fix.before)}</pre><pre class="code a">${esc(i.fix.after)}</pre>` : ''}
    ${canApply ? `<button class="primary" id="dr-go">Approve and replay</button><p class="fine">${i.kind === 'incident' ? 'The change is replayed against every run since go-live, then both systems are reconciled again.' : 'The workflow is updated and audited again.'} Logged.</p>`
      : `<button class="primary" id="dr-go">Mark as resolved</button><p class="fine">Make the change in n8n, export fresh files, and connect them again to confirm.</p>`}
    <button class="ghost" id="dr-ask">Ask the agent about this →</button>`);
  $('#dr-go').onclick = () => canApply ? approve(i) : resolve(i);
  $('#dr-ask').onclick = () => { closeDrawer(); nav('agent'); $('#a-sym').value = i.title; };
}

function approve(i) {
  const before = S.incidents.map(x => x.id);
  S.config = i.fix.apply(S.config); compute();
  const after = S.incidents.map(x => x.id), also = before.filter(id => id !== i.id && !after.includes(id));
  log(`Approved: ${i.fix.label}${also.length ? `. Also cleared ${also.length} related item${also.length > 1 ? 's' : ''}.` : ''}`);
  closeDrawer(); render(); toast(also.length ? `Fixed, plus ${also.length} related` : 'Fixed and replayed');
}
function resolve(i) { S.resolved.add(i.id); compute(); log(`Marked resolved: ${i.title}`); closeDrawer(); render(); toast('Marked as resolved'); }
function log(text) { S.log.unshift({ time: new Date().toISOString().slice(0, 16).replace('T', ' '), text }); }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.remove('on'), 2600); }

// Agent
function agentContext() {
  if (S.mode === 'demo') {
    const r = S.result, rec = r.rec;
    return {
      runLog: { runs: r.runs.length, statuses: { success: r.runs.length - r.errors, error: r.errors }, maxFetched: Math.max(...r.runs.map(x => x.fetched)), maxProcessed: Math.max(...r.runs.map(x => x.processed)), runsWhereProcessedLessThanFetched: r.runs.filter(x => x.processed < x.fetched).length, last5: r.runs.slice(-5).map(x => ({ at: new Date(x.at).toISOString().slice(0, 16), fetched: x.fetched, processed: x.processed, status: x.status, productsOutOfSync: x.drift })) },
      systems: { erpProducts: rec.erpCount, storeProducts: rec.shopCount, missingInStore: { count: rec.missing.length, examples: rec.missing.slice(0, 4).map(p => ({ sku: p.sku, created: new Date(p.created).toISOString().slice(0, 10) })) }, priceDiffs: { count: rec.priceDrift.length, examples: rec.priceDrift.slice(0, 4).map(x => ({ sku: x.sku, erp: x.erp, store: x.shop, created: new Date(x.created).toISOString().slice(0, 10), modified: new Date(x.modified).toISOString().slice(0, 10) })) }, stockDiffs: { count: rec.stockDrift.length, storeHigherThanErp: rec.oversellSkus }, storeOrders: rec.orders, matchingErpSalesOrders: rec.ordersInErp },
      workflow: S.wf, audit: S.audit,
      product: sku => { const p = W.erp.find(x => x.sku === sku); if (!p) return null; const s = r.state.shop.get(sku); return { sku, erp: { name: p.name, price: p.price, onHand: p.onHand, created: new Date(p.created).toISOString().slice(0, 10), modified: new Date(p.modified).toISOString().slice(0, 10) }, store: s || null }; },
    };
  }
  const rec = S.rec, shop = new Map(S.files.shop.map(r => [r.sku, r])), erp = new Map(S.files.erp.map(r => [r.sku, r]));
  return {
    runLog: null,
    systems: { erpProducts: rec.erpCount, storeProducts: rec.shopCount, missingInStore: { count: rec.missingInShop.length, examples: rec.missingInShop.slice(0, 4) }, missingInErp: { count: rec.missingInErp.length, examples: rec.missingInErp.slice(0, 4) }, priceDiffs: { count: rec.priceDrift.length, examples: rec.priceDrift.slice(0, 4) }, stockDiffs: { count: rec.stockDrift.length, storeHigherThanErp: rec.oversellSkus }, storeOrders: rec.orders, storeOrdersWithoutErpOrder: rec.unbooked.length },
    workflow: S.wf, audit: S.audit,
    product: sku => (erp.has(sku) || shop.has(sku)) ? { sku, erp: erp.get(sku) || null, store: shop.get(sku) || null } : null,
  };
}

async function investigate() {
  const box = $('#a-out'), steps = $('#a-steps'), btn = $('#a-run');
  const symptom = $('#a-sym').value.trim() || $('#a-sym').placeholder;
  steps.innerHTML = ''; box.textContent = 'Thinking…'; btn.disabled = true; $('#a-stop').hidden = false;
  ctl = new AbortController();
  const label = { get_run_log: 'Reading the run log', compare_systems: 'Comparing ERP and store', get_workflow: 'Reading the workflow and its audit', get_product: 'Checking a product' };
  const tools = agentTools(agentContext()).map(t => ({ ...t, execute: (input, c) => { steps.insertAdjacentHTML('beforeend', `<li>${esc(label[t.name] || t.name)}${input?.sku ? ` <code>${esc(String(input.sku).slice(0, 40))}</code>` : ''}</li>`); return t.execute(input || {}, c); } }));
  try { await sample(agentPrompt(symptom), { tools, signal: ctl.signal, onText: ({ text }) => { box.textContent = text; } }); }
  catch (e) {
    box.textContent = e.text || '';
    const msg = { not_granted: 'The agent needs permission to run. It uses your own Claude account.', rate_limited: 'Too many requests right now. Try again in a minute.', cancelled: '' }[e.code] ?? 'The investigation stopped. Try again.';
    if (msg) box.insertAdjacentHTML('beforeend', `<em class="note">${esc(msg)}</em>`);
  } finally { btn.disabled = false; $('#a-stop').hidden = true; }
}

// Sample export files built from the demo world, so the import path can be tried end to end.
function sampleFiles() {
  const r = S.mode === 'demo' ? S.result : detect(W, demoWorkflow(BUGGY), BUGGY);
  const csv = (head, rows) => [head.join(','), ...rows.map(x => x.map(safeCell).join(','))].join('\n');
  return [
    { name: 'n8n-workflow.json', text: JSON.stringify(buggyWorkflow(), null, 2) },
    { name: 'erp-released-products.csv', text: csv(['ItemNumber', 'ProductName', 'SalesPrice', 'AvailablePhysical'], W.erp.map(p => [p.sku, p.name, p.price, p.onHand])) },
    { name: 'shopify-products.csv', text: csv(['Variant SKU', 'Title', 'Variant Price', 'Variant Inventory Qty'], [...r.state.shop.values()].map(s => [s.sku, s.title, s.price, s.inventory])) },
    { name: 'shopify-orders.csv', text: csv(['Name', 'Total'], r.state.orders.map(o => [o.id, o.lines.reduce((a, l) => a + l.paid * l.qty, 0)])) },
    { name: 'erp-sales-orders.csv', text: csv(['SalesOrderNumber', 'CustomersOrderReference', 'Total'], r.state.orders.slice(0, 40).map((o, i) => [`SO-${10400 + i}`, o.id, o.lines.reduce((a, l) => a + l.paid * l.qty, 0)])) },
  ];
}
let host = null;
if (window.claude?.use) window.claude.use('downloads').then(d => { host = d; }).catch(() => {});
async function dlBlob(name, blob) {
  if (host) { try { await host.save({ filename: name, data: blob }); } catch {} return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Import real files
const pending = {};
async function readFile(input, kind) {
  const f = input.files[0]; input.value = ''; if (!f) return;
  const slot = input.closest('.slot'), st = slot.querySelector('.state');
  try {
    const { text } = decodeBytes(await f.arrayBuffer());
    if (kind === 'wf') { const wf = JSON.parse(text); if (!Array.isArray(wf.nodes)) throw new ImportError('This is not an n8n workflow export (no nodes found).'); pending.wf = wf; st.textContent = `${f.name} · ${wf.nodes.length} nodes`; }
    else if (kind === 'erp' || kind === 'shop') { pending[kind] = readRows(text, 'products', ['sku', 'name', 'price', 'stock']); st.textContent = `${f.name} · ${fmt(pending[kind].length)} products`; }
    else if (kind === 'shopOrders') { pending.shopOrders = readRows(text, 'orders', ['id', 'total']); st.textContent = `${f.name} · ${fmt(pending.shopOrders.length)} orders`; }
    else if (kind === 'erpOrders') { pending.erpOrders = readRows(text, 'orders', ['ref', 'total']); st.textContent = `${f.name} · ${fmt(pending.erpOrders.length)} orders`; }
    slot.classList.add('done'); slot.classList.remove('err');
  } catch (e) { st.textContent = e instanceof ImportError ? e.message : e instanceof SyntaxError ? 'Could not read this JSON file.' : 'Could not read this file.'; slot.classList.add('err'); slot.classList.remove('done'); }
  $('#imp-go').disabled = !((pending.erp && pending.shop) || pending.wf);
}
function runImport() {
  S.mode = 'files'; S.resolved = new Set(); S.log = [];
  S.files = { wf: pending.wf || null, erp: pending.erp || [], shop: pending.shop || [], shopOrders: pending.shopOrders || [], erpOrders: pending.erpOrders || [] };
  compute(); nav('overview'); toast('Checks complete');
}

document.addEventListener('DOMContentLoaded', () => {
  compute(); render(); nav('overview');
  document.querySelectorAll('[data-nav]').forEach(a => a.onclick = e => { e.preventDefault(); nav(a.dataset.nav); });
  document.querySelectorAll('[data-rf]').forEach(b => b.onclick = () => { S.recFilter = b.dataset.rf; renderRecon(); });
  $('#search').oninput = e => { S.q = e.target.value; renderRecon(); };
  $('#dr-x').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  $('#a-run').onclick = investigate; $('#a-stop').onclick = () => ctl?.abort();
  document.querySelectorAll('[data-sym]').forEach(b => b.onclick = () => { $('#a-sym').value = b.textContent; });
  document.querySelectorAll('.slot input').forEach(i => i.onchange = () => readFile(i, i.dataset.kind));
  $('#imp-go').onclick = runImport;
  $('#samples').onclick = e => { e.preventDefault(); dlBlob('syncwatch-sample-exports.zip', zip(sampleFiles())); };
  $('#demo').onclick = () => { S.mode = 'demo'; S.config = { ...BUGGY, swallow: true, paging: false, retry: false, alert: false }; S.log = []; compute(); nav('overview'); toast('Demo data reloaded'); };
  $('#burger').onclick = () => document.body.classList.toggle('nav-open');
  if (window.claude?.use) window.claude.use('sample').then(async s => { if (!s) return; const lim = await s.limits().catch(() => null); if (!lim?.tools) return; sample = s; document.body.classList.add('has-agent'); }).catch(() => {});
});
