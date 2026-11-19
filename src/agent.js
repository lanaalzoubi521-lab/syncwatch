// The investigation agent. Claude gets a symptom and four read-only tools over the
// monitor's evidence. It decides what to look at, then reports root causes and fixes.
// Nothing the agent says is applied: fixes go through human approval in the UI.
import { GO_LIVE } from './data.js';
import { replay, reconcile, scanSecrets } from './engine.js';

const d = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

export function agentTools(world, workflow, config) {
  const state = replay(world, config);
  const rec = reconcile(world, state, config);
  return [
    {
      name: 'get_run_log',
      description: 'Summary of the n8n workflow run history since go-live: run count, statuses, items fetched vs processed, and the last 5 runs.',
      execute: () => ({
        goLive: GO_LIVE, runs: state.runs.length,
        statuses: state.runs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}),
        maxFetched: Math.max(...state.runs.map(r => r.fetched)), maxProcessed: Math.max(...state.runs.map(r => r.processed)),
        runsWhereProcessedLessThanFetched: state.runs.filter(r => r.processed < r.fetched).length,
        last5: state.runs.slice(-5).map(r => ({ at: d(r.at), fetched: r.fetched, processed: r.processed, status: r.status })),
      }),
    },
    {
      name: 'compare_systems',
      description: 'Reconciles Dynamics 365 F&O with Shopify: product counts, products missing in Shopify, price and stock differences with each product\'s created and modified dates, and store orders vs ERP sales orders.',
      execute: () => ({
        erpProducts: rec.erpCount, shopifyProducts: rec.shopCount,
        missingInShopify: { count: rec.missing.length, examples: rec.missing.slice(0, 4).map(p => ({ sku: p.sku, created: d(p.created) })) },
        priceDiffs: { count: rec.priceDrift.length, examples: rec.priceDrift.slice(0, 4).map(x => ({ sku: x.sku, erp: x.erp, shop: x.shop, created: d(x.created), modified: d(x.modified) })) },
        stockDiffs: { count: rec.stockDrift.length, shopHigherThanErp: rec.oversellSkus },
        shopifyOrdersSinceGoLive: rec.orders, matchingErpSalesOrders: rec.ordersInErp,
      }),
    },
    {
      name: 'get_workflow',
      description: 'The n8n workflow JSON (nodes and parameters). Secret values are redacted, but you are told where a secret is stored inline.',
      execute: () => ({
        ...workflow,
        nodes: workflow.nodes.map(n => JSON.parse(JSON.stringify(n).replace(/Bearer [A-Za-z0-9\-_.]+/g, 'Bearer [REDACTED, stored inline in the workflow]'))),
        inlineSecrets: config.secretsInline ? scanSecrets(workflow).map(s => s.node) : [],
        hasOrderWriteBack: config.writeBack,
      }),
    },
    {
      name: 'get_product',
      description: 'One product by SKU, as the ERP and Shopify each hold it, with created and modified dates.',
      inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
      execute: ({ sku }) => {
        const p = world.erp.find(x => x.sku === String(sku));
        if (!p) throw new Error('No such SKU');
        return { sku: p.sku, erp: { name: p.name, price: p.price, onHand: p.onHand, created: d(p.created), modified: d(p.modified) }, shopify: state.shop.get(p.sku) || null };
      },
    },
  ];
}

export function agentPrompt(symptom) {
  return `You are an integration engineer investigating a Microsoft Dynamics 365 Finance & Operations to Shopify sync built in n8n, for a Dubai homeware retailer.

The operations team reports: "${symptom}"

Use the tools to gather evidence before concluding. Look at the run log, compare both systems, read the workflow, and check individual products where useful.

Then answer in plain English for an operations manager, under 220 words, in this format:

Root causes
1. <cause in one sentence> Evidence: <the numbers you saw>. Fix: <the exact change in the workflow>.
(one numbered item per distinct cause, most damaging first)

Verify after fixing
<one or two sentences on how to confirm the systems agree>

No markdown headers or bold. Do not invent numbers you did not get from a tool.`;
}
