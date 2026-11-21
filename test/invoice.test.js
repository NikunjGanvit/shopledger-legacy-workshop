const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');

function makeOrder(items, coupon = '') {
  const db = { nextOrderId: 1, orders: [] };
  return orders.add(db, {
    date: '2026-11-21',
    items,
    coupon,
    ...pricing.computeTotals(items, coupon)
  });
}

test('invoice agrees with the recorded bill for a default-rate sale without a coupon', () => {
  const order = makeOrder([{ name: 'Tea', price: 50, qty: 2 }]);

  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [100, 0, 18, 118]);
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 100,
    discount: 0,
    tax: 18,
    cgst: 9,
    sgst: 9,
    total: 118,
    rows: [
      { name: 'Tea', sku: '-', hsn: '-', qty: 2, price: 50, gstPercent: 18, line: 100, lineTax: 18 }
    ]
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice preserves the billed GST slabs for HSN-only lines without a coupon', () => {
  const order = makeOrder([
    { name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 2 },
    { name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 300, qty: 1 }
  ]);

  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 500,
    discount: 0,
    tax: 46,
    cgst: 23,
    sgst: 23,
    total: 546,
    rows: [
      { name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 100, gstPercent: 5, line: 200, lineTax: 10 },
      { name: 'Ghee', sku: 'GHEE', hsn: '0405', qty: 1, price: 300, gstPercent: 12, line: 300, lineTax: 36 }
    ]
  });
});

test('invoice uses the billed discount and post-discount GST for percentage, flat and capped coupons', () => {
  const cases = [
    { coupon: 'SAVE10', price: 500, expected: [50, 81, 531] },
    { coupon: 'FLAT50', price: 300, expected: [50, 45, 295] },
    { coupon: 'SAVE10', price: 2000, expected: [150, 333, 2183] }
  ];

  for (const { coupon, price, expected } of cases) {
    const order = makeOrder([{ name: 'Tea', price, qty: 1 }], coupon);
    const figures = invoice.computeInvoiceFigures(order);

    assert.deepEqual([figures.discount, figures.tax, figures.total], expected, coupon);
    assert.equal(figures.rows[0].lineTax, figures.tax, coupon);
  }
});

test('invoice handles whole-percent, decimal and zero GST rates as billing does', () => {
  const order = makeOrder([
    { name: 'Whole percent', price: 100, qty: 1, gstRate: 5 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures.rows.map(row => [row.gstPercent, row.lineTax]), [[5, 5], [5, 5], [0, 0]]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [10, 5, 5, 310]);
});

test('invoice uses billing’s per-line rounding and splits an odd paise of GST', () => {
  const order = makeOrder([
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.09, qty: 1 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.02]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.03, 0.02, 0.01, 0.15]);
});

test('invoice preserves historical amounts and uses billing rules for missing amounts', () => {
  const historical = invoice.computeInvoiceFigures({
    items: [{ name: 'Tea', price: 20, qty: 1 }],
    coupon: 'FLAT50',
    subtotal: '20.00',
    discount: '5.00',
    tax: '2.70',
    total: '17.70'
  });
  assert.deepEqual(
    [historical.subtotal, historical.discount, historical.tax, historical.cgst, historical.sgst, historical.total],
    [20, 5, 2.7, 1.35, 1.35, 17.7]
  );
  assert.equal(historical.rows[0].lineTax, 2.7);

  for (const [coupon, price, expectedTax, expectedTotal] of [
    ['FLAT50', 20, 3.6, 23.6],
    ['DIWALI20', 1000, 180, 1180]
  ]) {
    const figures = invoice.computeInvoiceFigures({ items: [{ name: 'Tea', price, qty: 1 }], coupon });
    assert.deepEqual([figures.discount, figures.tax, figures.total], [0, expectedTax, expectedTotal], coupon);
  }
});

test('printable invoice matches the bill and shows post-discount GST for each HSN slab', () => {
  const order = makeOrder([
    { name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 2 },
    { name: 'Ghee', sku: 'GHEE', hsn: '0405', price: 300, qty: 1 }
  ], 'SAVE10');

  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total], [500, 50, 41.4, 491.4]);
  const figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.total, 491.4);
  assert.deepEqual([figures.discount, figures.tax, figures.cgst, figures.sgst], [50, 41.4, 20.7, 20.7]);
  assert.deepEqual(figures.rows.map(row => [row.gstPercent, row.lineTax]), [[5, 9], [12, 32.4]]);

  const html = invoice.render(order);
  assert.ok(html.includes('<td class="r">5%</td><td class="r">₹9.00</td>'));
  assert.ok(html.includes('<td class="r">12%</td><td class="r">₹32.40</td>'));
  assert.ok(html.includes('<td>CGST + SGST (Total GST)</td><td class="r">₹41.40</td>'));
  assert.ok(html.includes('<td>Invoice Total</td><td class="r">₹491.40</td>'));
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});
