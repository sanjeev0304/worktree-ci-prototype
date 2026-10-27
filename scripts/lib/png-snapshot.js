/**
 * png-snapshot.js — zero-dependency fallback "visual snapshot" generator.
 *
 * Used by run-pre-pr-audit.js only when neither Playwright nor a headless
 * Chrome/Chromium is available. It draws the invoice result as a PNG using a
 * built-in 5x7 bitmap font, so there is always visual evidence to commit.
 */
'use strict';

const zlib = require('zlib');

// 5x7 bitmap font: 7 rows of 5 bits per glyph. Lowercase is drawn as uppercase.
const FONT = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 10001 11001 10101 10011 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 10101 01010', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11111 00010 00100 00010 00001 10001 01110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
  ' ': '00000 00000 00000 00000 00000 00000 00000', '.': '00000 00000 00000 00000 00000 01100 01100',
  ',': '00000 00000 00000 00000 01100 00100 01000', ':': '00000 01100 01100 00000 01100 01100 00000',
  '-': '00000 00000 00000 11111 00000 00000 00000', '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000', '%': '11000 11001 00010 00100 01000 10011 00011',
  '#': '01010 01010 11111 01010 11111 01010 01010', '/': '00000 00001 00010 00100 01000 10000 00000',
  '+': '00000 00100 00100 11111 00100 00100 00000', '=': '00000 00000 11111 00000 11111 00000 00000',
  '!': '00100 00100 00100 00100 00100 00000 00100', '?': '01110 10001 00001 00010 00100 00000 00100',
};

const COLORS = {
  bg: [244, 246, 251], header: [27, 35, 51], white: [255, 255, 255], ink: [27, 35, 51],
  muted: [91, 101, 120], line: [227, 231, 239], bad: [198, 40, 40], good: [27, 127, 59],
};

function createCanvas(width, height, color) {
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) px.set(color, i * 3);
  return { width, height, px };
}

function fillRect(c, x, y, w, h, color) {
  for (let yy = Math.max(0, y); yy < Math.min(c.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(c.width, x + w); xx++) c.px.set(color, (yy * c.width + xx) * 3);
  }
}

function drawText(c, text, x, y, scale, color) {
  let cx = x;
  for (const ch of String(text).replace(/₹/g, 'RS ').toUpperCase()) {
    const rows = (FONT[ch] || FONT['?']).split(' ');
    rows.forEach((row, ry) => {
      [...row].forEach((bit, rx) => {
        if (bit === '1') fillRect(c, cx + rx * scale, y + ry * scale, scale, scale, color);
      });
    });
    cx += 6 * scale;
  }
  return cx;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(c) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.width, 0);
  ihdr.writeUInt32BE(c.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((c.width * 3 + 1) * c.height);
  for (let y = 0; y < c.height; y++) {
    raw[y * (c.width * 3 + 1)] = 0; // filter: none
    c.px.copy(raw, y * (c.width * 3 + 1) + 1, y * c.width * 3, (y + 1) * c.width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draws the dashboard result card.
 * @param {object} apiResult response JSON from POST /api/calculate-invoice
 * @returns {Buffer} PNG bytes
 */
function renderInvoiceSnapshot(apiResult, { url, generatedAt }) {
  const c = createCanvas(900, 560, COLORS.bg);
  fillRect(c, 0, 0, 900, 80, COLORS.header);
  drawText(c, 'Enterprise Invoice Dashboard', 32, 22, 3, COLORS.white);
  drawText(c, url, 32, 56, 2, [184, 193, 214]);

  fillRect(c, 32, 110, 836, 360, COLORS.white);
  fillRect(c, 32, 110, 836, 2, COLORS.line);
  drawText(c, 'Invoice', 56, 132, 3, COLORS.ink);

  const inv = apiResult.invoice;
  const money = (n) => 'RS ' + Number(n).toFixed(2);
  const rows = [
    ['Customer', `${apiResult.customer.name} (${apiResult.customer.type})`],
    ['Subtotal', money(inv.subtotal)],
    ['Discount', `-${money(inv.discount)} (${Math.round(apiResult.rates.vipDiscount * 100)}%)`],
    ['GST', `${money(inv.gst)} (${Math.round(apiResult.rates.gstRate * 100)}%)`],
    ['Total', money(inv.total)],
  ];
  rows.forEach(([label, value], i) => {
    const y = 186 + i * 44;
    drawText(c, label, 56, y, 2, COLORS.muted);
    drawText(c, value, 844 - value.length * 12, y, 2, COLORS.ink);
    fillRect(c, 56, y + 26, 788, 1, COLORS.line);
  });

  const ok = apiResult.rates.gstRate === 0.18 && apiResult.rates.vipDiscount <= 0.1;
  drawText(c, `RULE #404: ${ok ? 'COMPLIANT' : 'VIOLATED'}`, 56, 420, 2, ok ? COLORS.good : COLORS.bad);

  drawText(c, 'Fallback snapshot (no browser found)', 32, 494, 2, COLORS.muted);
  drawText(c, `Generated ${generatedAt}`, 32, 522, 2, COLORS.muted);
  return encodePng(c);
}

module.exports = { renderInvoiceSnapshot };
