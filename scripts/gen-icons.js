'use strict';
// 生成应用图标（PNG + ICO）——纯 Node 实现，无第三方依赖
// 图标设计：圆角方块渐变底 + 白色心电折线（监控含义）
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');
fs.mkdirSync(OUT, { recursive: true });

function lerp(a, b, t) { return a + (b - a) * t; }

// 简单有符号距离场画布
function makeCanvas(size) {
  return { size, data: new Float32Array(size * size) }; // 0 = 透明, 1 = 实心
}

// 在 canvas 上绘制圆角矩形（SDF），cx,cy 中心
function fillRoundRect(cv, cx, cy, hw, hh, r) {
  const { size, data } = cv;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - cx, py = y + 0.5 - cy;
      const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const idx = y * size + x;
      const cov = Math.min(1, Math.max(0, 0.5 - d)); // 1px 抗锯齿
      if (cov > data[idx]) data[idx] = cov;
    }
  }
}

// 绘制折线（宽 w），points 为归一化坐标 (0..1)
function strokePolyline(cv, pts, w, scale = 1, dx = 0, dy = 0) {
  const { size, data } = cv;
  const P = pts.map(([x, y]) => [x * size * scale + dx * size, y * size * scale + dy * size]);
  const segs = [];
  for (let i = 0; i < P.length - 1; i++) segs.push([P[i], P[i + 1]]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let d = Infinity;
      for (const [[x1, y1], [x2, y2]] of segs) {
        const vx = x2 - x1, vy = y2 - y1;
        const len2 = vx * vx + vy * vy || 1e-9;
        let t = ((px - x1) * vx + (py - y1) * vy) / len2;
        t = Math.max(0, Math.min(1, t));
        const ddx = px - (x1 + t * vx), ddy = py - (y1 + t * vy);
        d = Math.min(d, Math.hypot(ddx, ddy));
      }
      const cov = Math.min(1, Math.max(0, (w / 2 + 0.5) - d));
      const idx = y * size + x;
      if (cov > data[idx]) data[idx] = cov;
    }
  }
}

// 圆点
// eslint-disable-next-line no-unused-vars -- 备用图元，供后续图标样式调整使用
function fillCircle(cv, cx, cy, r) {
  const { size, data } = cv;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const cov = Math.min(1, Math.max(0, 0.5 - d));
      const idx = y * size + x;
      if (cov > data[idx]) data[idx] = cov;
    }
  }
}

// 渐变色（左上 -> 右下）：#0a84ff -> #5e5ce6
function gradColor(t) {
  const c1 = [10, 132, 255], c2 = [94, 92, 230];
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function renderPNG(size) {
  const cv = makeCanvas(size);
  const m = size * 0.04;                     // 外边距
  fillRoundRect(cv, size / 2, size / 2, size / 2 - m, size / 2 - m, size * 0.225);

  // 背景层（渐变圆角方块）
  const bg = new Float32Array(cv.data);

  // 白色心电折线层（独立画布，保证覆盖背景）
  const pts = [
    [0.16, 0.56], [0.34, 0.56], [0.42, 0.40], [0.52, 0.68], [0.60, 0.50],
    [0.66, 0.56], [0.84, 0.56]
  ];
  const line = makeCanvas(size);
  strokePolyline(line, pts, size * 0.085);

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (2 * size);
      const la = line.data[y * size + x];   // 折线覆盖度
      const ba = bg[y * size + x];          // 背景覆盖度
      let a, r, g, b;
      if (la > 0.02) {
        // 折线：白色（与背景混合边缘抗锯齿）
        const mix = Math.min(1, la);
        a = Math.max(ba, mix);
        r = lerp(gradColor(t)[0], 255, mix);
        g = lerp(gradColor(t)[1], 255, mix);
        b = lerp(gradColor(t)[2], 255, mix);
        r = Math.round(r); g = Math.round(g); b = Math.round(b);
      } else {
        a = ba;
        const [br, bgc, bb] = gradColor(t);
        r = Math.round(br); g = Math.round(bgc); b = Math.round(bb);
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(rgba, size, size);
}

// ---- PNG 编码（含 zlib，Node 内置） ----
const zlib = require('zlib');
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- ICO 封装（PNG-in-ICO，Vista+ 支持） ----
function encodeICO(pngBuffers) {
  // pngBuffers: [{size, data}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngBuffers.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngBuffers.length;
  for (const { size, data } of pngBuffers) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.data)]);
}

const png256 = renderPNG(256);
const png64 = renderPNG(64);
const png48 = renderPNG(48);
const png32 = renderPNG(32);
const png16 = renderPNG(16);

fs.writeFileSync(path.join(OUT, 'icon.png'), png256);
fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeICO([
  { size: 256, data: png256 }, { size: 64, data: png64 }, { size: 48, data: png48 },
  { size: 32, data: png32 }, { size: 16, data: png16 }
]));
console.log('icons written to', OUT);
