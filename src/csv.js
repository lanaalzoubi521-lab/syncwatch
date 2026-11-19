// File import shared with PINT-AE Preflight: encodings, delimiters, number formats, formula-safe output.
export const LIMITS = { bytes: 20 * 1024 * 1024, rows: 200000 };

export function decodeBytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length > LIMITS.bytes) throw new ImportError(`File is ${(u8.length / 1048576).toFixed(1)} MB. The limit is ${LIMITS.bytes / 1048576} MB. Split the export by month.`);
  try { return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(u8)), encoding: 'UTF-8' }; }
  catch { return { text: stripBom(new TextDecoder('windows-1256').decode(u8)), encoding: 'Windows-1256' }; }
}
const stripBom = t => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

export class ImportError extends Error {}

export function detectDelimiter(text) {
  const first = text.slice(0, text.search(/\r?\n/) >>> 0 || 2000);
  const counts = [',', ';', '\t'].map(d => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCSV(text, delim = detectDelimiter(text)) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      if (rows.length > LIMITS.rows + 1) throw new ImportError(`More than ${LIMITS.rows.toLocaleString()} rows. Split the export by month.`);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  if (rows.length < 2) throw new ImportError('The file has no data rows.');
  const [head, ...body] = rows;
  return { columns: head.map(h => h.trim()), rows: body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()]))) };
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function normalizeNumber(v) {
  let s = String(v ?? '').trim().replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d)).replace(/[\s ]/g, '');
  if (!s) return '';
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');          // 1,234.50
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,50
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');                         // 12,5
  return s;
}

// CSV out. Cells that a spreadsheet would run as a formula are neutralised.
export function safeCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const norm = s => String(s).toLowerCase().replace(/[_\-\s.:/()%]+/g, ' ').trim();
// Column names as D365 F&O and Shopify exports usually write them, plus common variants.
export const COLUMNS = {
  products: { sku: ['sku', 'variant sku', 'item number', 'itemnumber', 'product number', 'item', 'item id'], name: ['name', 'title', 'product name', 'productname', 'search name'], price: ['price', 'variant price', 'sales price', 'salesprice', 'unit price'], stock: ['stock', 'inventory', 'variant inventory qty', 'inventory quantity', 'available physical', 'availablephysical', 'on hand', 'onhand', 'physical inventory', 'qty'] },
  orders: { id: ['name', 'order', 'order number', 'order id', 'id'], ref: ['customers order reference', 'customersorderreference', 'customer reference', 'external reference', 'reference', 'order reference'], total: ['total', 'order total', 'amount', 'total amount'] },
};
export function readRows(text, kind, want) {
  const { columns, rows } = parseCSV(text);
  const by = new Map(columns.map(c => [norm(c), c]));
  const map = {};
  for (const f of want) for (const syn of COLUMNS[kind][f]) if (by.has(norm(syn))) { map[f] = by.get(norm(syn)); break; }
  const missing = want.filter(f => !map[f] && f !== 'name' && f !== 'stock' && f !== 'total');
  if (missing.length) throw new ImportError(`Could not find the ${missing.join(' and ')} column. Found: ${columns.slice(0, 8).join(', ')}${columns.length > 8 ? '…' : ''}`);
  const num = v => { const n = Number(normalizeNumber(v)); return v === '' || v == null || isNaN(n) ? null : n; };
  return rows.map(r => {
    const o = {}; for (const f of want) o[f] = map[f] ? r[map[f]] : null;
    for (const f of ['price', 'stock', 'total']) if (f in o) o[f] = num(o[f]);
    if (o.sku != null) o.sku = String(o.sku).trim();
    return o;
  }).filter(o => (o.sku ?? o.id ?? o.ref) !== '');
}

// Minimal ZIP writer (stored, no compression) so all ready invoices download as one file.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files) {
  const enc = new TextEncoder(), parts = [], dir = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const d = new DataView(new ArrayBuffer(46));
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true); d.setUint32(16, crc, true);
    d.setUint32(20, data.length, true); d.setUint32(24, data.length, true); d.setUint16(28, name.length, true); d.setUint32(42, off, true);
    dir.push(new Uint8Array(d.buffer), name);
    off += 30 + name.length + data.length;
  }
  const size = dir.reduce((a, p) => a + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...dir, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

// Demo dataset: Raml Home, a fictional Dubai homeware retailer.
// Its ERP export carries the kind of master-data gaps most UAE businesses discover late.
export function sampleInvoices() {
  const seller = {
    seller_name: 'Raml Home Trading LLC', seller_tin: '1004587213', seller_trn: '100458721300003',
    seller_legal_id: 'DED-1187642', seller_legal_type: 'TL', seller_address: 'Warehouse 14, Al Quoz Industrial 3',
    seller_city: 'Dubai', seller_subdivision: 'DXB', seller_country: 'AE', accounting_currency: 'AED',
  };
  const customers = [
    { buyer_name: 'Al Noor Hospitality LLC', buyer_endpoint: '1008821457', buyer_trn: '100882145700003', buyer_vat_registered: 'yes', buyer_address: 'Office 902, Bay Square 4', buyer_city: 'Dubai', buyer_subdivision: '', buyer_country: 'AE', payment_means: '30', terms: 30 },
    { buyer_name: 'Saadiyat Living Interiors', buyer_endpoint: '1009934120', buyer_trn: '10099341200003', buyer_vat_registered: 'yes', buyer_address: 'Villa 21, Saadiyat Cultural District', buyer_city: 'Abu Dhabi', buyer_subdivision: 'AUH', buyer_country: 'AE', payment_means: '30', terms: 45 },
    { buyer_name: 'Corniche Stays Hotel Apartments', buyer_endpoint: '1007712093', buyer_trn: '100771209300003', buyer_vat_registered: 'yes', buyer_address: 'Al Majaz 2, Corniche Street', buyer_city: 'Sharjah', buyer_subdivision: 'Sharjah', buyer_country: 'AE', payment_means: '30', terms: 30 },
    { buyer_name: 'Marina Key Property Management', buyer_endpoint: '1006620981', buyer_trn: '100662098100003', buyer_vat_registered: 'yes', buyer_address: 'Marina Plaza, Level 18', buyer_city: 'Dubai', buyer_subdivision: 'DXB', buyer_country: 'AE', payment_means: '30', terms: null },
    { buyer_name: 'Hatta Retreats FZ-LLC', buyer_endpoint: '1005519876', buyer_trn: '100551987600003', buyer_vat_registered: 'yes', buyer_address: 'Hatta Road, Plot 7', buyer_city: 'Dubai', buyer_subdivision: 'DXB', buyer_country: 'AE', payment_means: '30', terms: 30 },
    { buyer_name: 'Gulf Coast Fit-Out Co.', buyer_endpoint: '1004410765', buyer_trn: '100441076500003', buyer_vat_registered: 'yes', buyer_address: 'Industrial Area 6', buyer_city: 'Ajman', buyer_subdivision: 'AJM', buyer_country: 'AE', payment_means: '30', terms: 60 },
  ];
  const items = [
    { item_code: 'LN-THR-01', item_name: 'Washed linen throw', item_description: 'Washed linen throw, 130 x 170 cm, sand', uom: 'pcs', price: 185 },
    { item_code: 'CR-VAS-07', item_name: 'Ceramic vase, tall', item_description: 'Hand-glazed ceramic vase, 42 cm', uom: 'H87', price: 240 },
    { item_code: 'CT-CUS-03', item_name: 'Cotton cushion cover', item_description: '', uom: 'H87', price: 65 },
    { item_code: 'OK-TBL-12', item_name: 'Oak side table', item_description: 'Solid oak side table, oiled finish', uom: 'H87', price: 890 },
    { item_code: 'RT-BSK-02', item_name: 'Rattan basket set', item_description: 'Set of three rattan storage baskets', uom: 'SET', price: 320 },
    { item_code: 'SV-INS-01', item_name: 'Styling and installation', item_description: 'On-site styling and installation, per hour', uom: 'hours', price: 150 },
  ];
  // deterministic pseudo-random
  let s = 7;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const invoices = [];
  const start = Date.UTC(2026, 9, 1);
  for (let i = 0; i < 84; i++) {
    const c = customers[Math.floor(rnd() * customers.length)];
    const date = new Date(start + Math.floor(i * 0.9) * 86400000);
    const due = c.terms ? new Date(date.getTime() + c.terms * 86400000) : null;
    const no = `RH-INV-${String(2026001 + i)}`;
    const n = 1 + Math.floor(rnd() * 3);
    const lines = [];
    const used = new Set();
    for (let k = 0; k < n; k++) {
      let it = items[Math.floor(rnd() * items.length)];
      if (used.has(it.item_code)) continue;
      used.add(it.item_code);
      const qty = 1 + Math.floor(rnd() * 12);
      let net = +(qty * it.price).toFixed(2);
      if (i === 37 && k === 0) net = +(net + 0.4).toFixed(2); // rounding drift from a manual edit
      lines.push({
        line_id: String(lines.length + 1), item_code: it.item_code, item_name: it.item_name, item_description: it.item_description,
        qty: String(qty), uom: it.uom, net_price: it.price.toFixed(2), gross_price: it.price.toFixed(2), base_qty: '1',
        line_net: net.toFixed(2), tax_category: 'S', tax_rate: '5',
        line_vat_aed: (net * 0.05).toFixed(2), line_amount_aed: (net * 1.05).toFixed(2),
      });
    }
    const { terms, ...cust } = c;
    invoices.push({
      invoice_no: no, invoice_date: date.toISOString().slice(0, 10), type_code: '380', currency: 'AED',
      transaction_flags: '00000000', due_date: due ? due.toISOString().slice(0, 10) : '',
      ...seller, ...cust, lines,
    });
  }
  // An export with the wrong rate, and a legacy flag value from an old integration.
  invoices[52] = { ...invoices[52], buyer_name: 'Muscat Design House SAOC', buyer_endpoint: '0198823401', buyer_trn: '', buyer_vat_registered: 'no', buyer_address: 'Al Khuwair, Way 3013', buyer_city: 'Muscat', buyer_subdivision: 'MA', buyer_country: 'OM', transaction_flags: '00000001', lines: invoices[52].lines.map(l => ({ ...l, tax_category: 'Z', tax_rate: '5' })) };
  invoices[61] = { ...invoices[61], transaction_flags: '0000000' };
  return invoices;
}
