// Code node body for the daily SyncWatch check (n8n Code node, "Run Once for All Items").
// Adjust the four field names to match your ERP entity.
const ERP_SKU = 'ItemNumber';
const ERP_NAME = 'ProductName';
const ERP_PRICE = 'SalesPrice';
const PRICE_TOLERANCE = 0.01;

const erpRows = $('Get ERP products').all().flatMap(i => i.json.value || [i.json]);
const shopVariants = $('Get Shopify products').all().flatMap(i => (i.json.variants || []).map(v => ({ sku: String(v.sku || '').trim(), price: Number(v.price), title: i.json.title })));

const shop = new Map(shopVariants.filter(v => v.sku).map(v => [v.sku, v]));
const erp = new Map(erpRows.map(r => [String(r[ERP_SKU] || '').trim(), r]).filter(([k]) => k));

const missingInStore = [...erp.keys()].filter(k => !shop.has(k));
const missingInErp = [...shop.keys()].filter(k => !erp.has(k));
const priceDiffs = [];
for (const [sku, r] of erp) {
  const s = shop.get(sku);
  if (s && Math.abs(Number(r[ERP_PRICE]) - s.price) > PRICE_TOLERANCE) priceDiffs.push({ sku, name: r[ERP_NAME], erp: Number(r[ERP_PRICE]), store: s.price });
}
const total = missingInStore.length + missingInErp.length + priceDiffs.length;
const list = (title, arr, fmt) => arr.length ? `${title} (${arr.length})\n` + arr.slice(0, 20).map(fmt).join('\n') + (arr.length > 20 ? `\n…and ${arr.length - 20} more` : '') + '\n\n' : '';

return [{ json: {
  total,
  erpProducts: erp.size, storeProducts: shop.size,
  missingInStore: missingInStore.length, missingInErp: missingInErp.length, priceDiffs: priceDiffs.length,
  subject: `SyncWatch: ${total} differences between the ERP and the store`,
  body: `Daily check, ${new Date().toISOString().slice(0, 10)}\nERP products: ${erp.size}\nStore products: ${shop.size}\n\n`
    + list('In the ERP, not in the store', missingInStore, s => `- ${s}`)
    + list('In the store, not in the ERP', missingInErp, s => `- ${s}`)
    + list('Price differs', priceDiffs, d => `- ${d.sku} ${d.name || ''}: ERP ${d.erp}, store ${d.store}`),
} }];
