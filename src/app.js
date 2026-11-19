// SyncWatch interface.
const W = buildWorld(), WF = buggyWorkflow();
const S = { config: { ...BUGGY }, result: null, log: [], prev: null };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let sample = null;

function go(view) {
  const cur = document.querySelector('.view.on'), next = $('#v-' + view);
  if (cur === next) return;
  document.querySelectorAll('nav [data-go]').forEach(b => b.classList.toggle('on', b.dataset.go === view || (view === 'finding' && b.dataset.go === 'overview')));
  if (cur) { cur.classList.add('out'); setTimeout(() => cur.classList.remove('on', 'out'), 400); }
  setTimeout(() => { next.classList.add('on'); window.scrollTo(0, 0); }, cur ? 240 : 0);
}

function count(el, to, fmt = v => v, ms = 1000) {
  const from = Number(el.dataset.v ?? to); el.dataset.v = to;
  const t0 = performance.now();
  const tick = t => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

function compute() { S.result = detect(W, WF, S.config); }

function renderOverview() {
  const { rec, findings, runs, errors } = S.result;
  $('#runs').textContent = runs.length;
  $('#errs').textContent = errors;
  count($('#n-find'), findings.length);
  $('#verdict').textContent = findings.length ? (findings.length === 1 ? 'thing the run log never mentioned.' : 'things the run log never mentioned.') : 'Both systems agree.';
  $('#n-find').style.display = findings.length ? '' : 'none';
  count($('#r-erp'), rec.erpCount); count($('#r-shop'), rec.shopCount);
  count($('#r-ord'), rec.orders); count($('#r-ordE'), rec.ordersInErp);
  count($('#r-drift'), new Set([...rec.priceDrift, ...rec.stockDrift].map(d => d.sku)).size);
  $('#findings').innerHTML = findings.map((f, i) => `
    <li style="--d:${i * 60}ms"><button data-id="${f.id}">
      <span class="no">0${i + 1}</span>
      <span class="t"><b>${esc(f.title)}</b><span>${esc(f.lede)}</span></span>
      <span class="ar">Review →</span>
    </button></li>`).join('') || `<li class="ok"><span class="no">✓</span><span class="t"><b>No silent failures.</b><span>Product counts, prices, stock and orders reconcile. The run log and the data now tell the same story.</span></span></li>`;
  document.querySelectorAll('#findings button').forEach(b => b.onclick = () => openFinding(b.dataset.id));
  $('#log').innerHTML = S.log.map(l => `<li><code>${esc(l.time)}</code><span>${esc(l.text)}</span></li>`).join('');
  $('#logwrap').style.display = S.log.length ? '' : 'none';
}

function openFinding(id) {
  const f = S.result.findings.find(x => x.id === id); if (!f) return;
  $('#f-title').textContent = f.title;
  $('#f-lede').textContent = f.lede;
  $('#f-cause').textContent = f.cause;
  $('#f-ev').innerHTML = f.evidence.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('#f-sample').innerHTML = f.sample.length ? f.sample.map(r => `<li>${r.map(c => `<span>${esc(c)}</span>`).join('')}</li>`).join('') : '';
  $('#f-samplewrap').style.display = f.sample.length ? '' : 'none';
  $('#f-before').textContent = f.fix.before;
  $('#f-after').textContent = f.fix.after;
  $('#f-fixlabel').textContent = f.fix.label;
  $('#approve').onclick = () => approve(f);
  go('finding');
}

function approve(f) {
  const before = S.result.findings.map(x => x.id);
  S.config = f.fix.apply(S.config);
  compute();
  const after = S.result.findings.map(x => x.id);
  const also = before.filter(id => id !== f.id && !after.includes(id));
  const t = new Date().toISOString().slice(0, 19).replace('T', ' ');
  S.log.unshift({ time: t, text: `Approved: ${f.fix.label}. Replayed ${S.result.runs.length} runs.${also.length ? ` Also cleared: ${also.length} related finding${also.length > 1 ? 's' : ''}.` : ''}` });
  renderOverview(); go('overview');
}

// Agent
let ctl = null;
async function investigate() {
  const box = $('#a-out'), steps = $('#a-steps'), btn = $('#a-run');
  const symptom = $('#a-sym').value.trim() || $('#a-sym').placeholder;
  steps.innerHTML = ''; box.textContent = 'Thinking…'; btn.disabled = true; $('#a-stop').hidden = false;
  ctl = new AbortController();
  const label = { get_run_log: 'Reading the run log', compare_systems: 'Comparing ERP and Shopify', get_workflow: 'Reading the workflow', get_product: 'Checking a product' };
  const tools = agentTools(W, WF, S.config).map(t => ({ ...t, execute: (input, ctx) => {
    steps.insertAdjacentHTML('beforeend', `<li>${esc(label[t.name] || t.name)}${input?.sku ? ` <code>${esc(input.sku)}</code>` : ''}</li>`);
    return t.execute(input || {}, ctx);
  } }));
  try {
    await sample(agentPrompt(symptom), { tools, signal: ctl.signal, onText: ({ text }) => { box.textContent = text; } });
  } catch (e) {
    box.textContent = e.text || '';
    const msg = { not_granted: 'The agent needs permission to run. It uses your own Claude account.', rate_limited: 'Too many requests right now. Try again in a minute.', cancelled: '' }[e.code] ?? 'The investigation stopped. Try again.';
    if (msg) box.insertAdjacentHTML('beforeend', `<em class="note">${esc(msg)}</em>`);
  } finally { btn.disabled = false; $('#a-stop').hidden = true; }
}

document.addEventListener('DOMContentLoaded', () => {
  compute(); renderOverview(); go('overview');
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#a-run').onclick = investigate;
  $('#a-stop').onclick = () => ctl?.abort();
  document.querySelectorAll('[data-sym]').forEach(b => b.onclick = () => { $('#a-sym').value = b.textContent; });
  $('#reset').onclick = () => { S.config = { ...BUGGY }; S.log = []; compute(); renderOverview(); };
  if (window.claude?.use) {
    window.claude.use('sample').then(async s => {
      if (!s) return;
      const lim = await s.limits().catch(() => null);
      if (!lim?.tools) return;
      sample = s; document.body.classList.add('has-agent');
    }).catch(() => {});
  }
});
