// 把矢量化图标按徽章真实观感渲染成 PNG（sharp 栅格化 SVG），供自检。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const match = source.match(/const BRAND_ICON_EXTRAS = \{([\s\S]*?)\};/);
const extras = new Function(`return {${match[1]}};`)();
const keys = Object.keys(extras);

// 每个图标一行：深底 30/22/15 + 浅底 30/22/15 + 深底放大 96。
const ROW_H = 120;
const tile = (key, size, x, y, dark) => {
  const icon = extras[key];
  const r = Math.round(size * 0.3);
  const inner = Math.round(size * 0.62);
  const pad = (size - inner) / 2;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${dark ? '#2a2d34' : '#f3f4f6'}"/>
  <svg x="${x + pad}" y="${y + pad}" width="${inner}" height="${inner}" viewBox="0 0 ${icon.w} ${icon.h}"><path d="${icon.d}" fill="${dark ? '#aab4c8' : '#4b5563'}" fill-rule="evenodd"/></svg>`;
};

const rows = keys.map((key, i) => {
  const y = 20 + i * ROW_H;
  const parts = [];
  let x = 20;
  for (const size of [30, 22, 15]) { parts.push(tile(key, size, x, y + 10, true)); x += size + 10; }
  x += 20;
  for (const size of [30, 22, 15]) { parts.push(tile(key, size, x, y + 10, false)); x += size + 10; }
  parts.push(tile(key, 96, 420, y, true));
  return parts.join('');
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="${20 + keys.length * ROW_H}"><rect width="100%" height="100%" fill="#9aa2ad"/>${rows}</svg>`;
const out = join(HERE, '..', '..', 'demos', 'brand-icons-render.png');
await sharp(Buffer.from(svg), { density: 144 }).png().toFile(out);
console.log('已生成：' + out);
