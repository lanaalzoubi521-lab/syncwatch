import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lintWorkflow } from '../src/engine.js';

const wf = JSON.parse(readFileSync(new URL('../n8n/syncwatch-daily-check.json', import.meta.url)));
const run = (erp, shop) => {
  const code = wf.nodes.find(n => n.name === 'Compare').parameters.jsCode;
  const $ = name => ({ all: () => (name === 'Get ERP products' ? erp : shop).map(json => ({ json })) });
  return new Function('$', code)($)[0].json;
};

test('every connection points at a real node', () => {
  const names = new Set(wf.nodes.map(n => n.name));
  for (const [from, c] of Object.entries(wf.connections)) { assert.ok(names.has(from), from); for (const out of c.main) for (const l of out) assert.ok(names.has(l.node), l.node); }
});
test('compare finds missing products and price differences across pages', () => {
  const erp = [{ value: [{ ItemNumber: 'A', ProductName: 'Vase', SalesPrice: 240 }, { ItemNumber: 'B', SalesPrice: 100 }] }, { value: [{ ItemNumber: 'C', SalesPrice: 50 }] }];
  const shop = [{ title: 'Vase', variants: [{ sku: 'A', price: '240.00' }] }, { title: 'Bowl', variants: [{ sku: 'B', price: '90.00' }] }, { title: 'Mug', variants: [{ sku: 'Z', price: '10' }] }];
  const r = run(erp, shop);
  assert.equal(r.missingInStore, 1); assert.equal(r.missingInErp, 1); assert.equal(r.priceDiffs, 1); assert.equal(r.total, 3);
  assert.match(r.body, /B .*ERP 100, store 90/);
});
test('no differences, no alert content', () => { assert.equal(run([{ value: [{ ItemNumber: 'A', SalesPrice: 1 }] }], [{ variants: [{ sku: 'A', price: '1' }] }]).total, 0); });
test('the monitor passes its own audit except credentials it expects you to add', () => {
  const ids = lintWorkflow(wf).map(a => a.id);
  for (const bad of ['secret', 'limit', 'filter', 'swallow', 'paging']) assert.ok(!ids.includes(bad), bad);
});
