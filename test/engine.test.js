import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, buggyWorkflow } from '../src/data.js';
import { detect, replay, BUGGY, scanSecrets } from '../src/engine.js';

const w = buildWorld(), wf = buggyWorkflow();

test('the run log alone looks healthy', () => {
  const { runs, errors } = detect(w, wf, BUGGY);
  assert.ok(runs.length > 100); assert.equal(errors, 0);
});
test('all four silent failures are detected', () => {
  assert.deepEqual(detect(w, wf, BUGGY).findings.map(f => f.id).sort(), ['filter', 'limit', 'secret', 'writeback']);
});
test('limit: missing products are exactly the ones beyond the cap', () => {
  const { rec } = detect(w, wf, BUGGY);
  const noLimit = detect(w, wf, { ...BUGGY, limit: null }).rec;
  assert.ok(rec.missing.length > 0); assert.equal(noLimit.missing.length, 0);
});
test('filter: every drifted product predates go-live', () => {
  const { rec } = detect(w, wf, BUGGY);
  const goLive = Date.parse('2026-10-01T00:00:00Z');
  assert.ok(rec.priceDrift.every(d => d.created < goLive && d.modified > goLive));
});
test('each fix removes its own finding', () => {
  const base = detect(w, wf, BUGGY).findings;
  for (const f of base) {
    const after = detect(w, wf, f.fix.apply(BUGGY)).findings.map(x => x.id);
    assert.ok(!after.includes(f.id), f.id);
  }
});
test('all fixes: systems agree', () => {
  let c = BUGGY; for (const f of detect(w, wf, c).findings) c = f.fix.apply(c);
  const r = detect(w, wf, c);
  assert.equal(r.findings.length, 0);
  assert.equal(r.rec.missing.length + r.rec.priceDrift.length + r.rec.stockDrift.length, 0);
  assert.equal(r.rec.ordersInErp, r.rec.orders);
});
test('secret scanner finds the inline token', () => { assert.equal(scanSecrets(wf).length, 1); });
test('replay is deterministic', () => { assert.equal(replay(w, BUGGY).shop.size, replay(buildWorld(), BUGGY).shop.size); });
