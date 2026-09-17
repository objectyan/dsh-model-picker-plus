// 渲染 models.dev 官方标的徽章观感图（供自检）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const match = source.match(/const BRAND_LOGOS = \{([\s\S]*?)\};/);
const logos = new Function(`return {${match[1]}};`)();
const keys = Object.keys(logos);

const ROW_H = 64;
const COLS = 5;
const tile = (key, size, x, y, dark) => {
  const logo = logos[key];
  const r = Math.round(size * 0.3);
  const inner = Math.round(size * 0.62);
  const pad = (size - inner) / 2;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${dark ? '#2a2d34' : '#f3f4f6'}"/>
  <svg x="${x + pad}" y="${y + pad}" width="${inner}" height="${inner}" viewBox="${logo.vb}" preserveAspectRatio="xMidYMid meet" fill="currentColor" color="${dark ? '#aab4c8' : '#4b5563'}">${logo.s}</svg>`;
};

// 每行 5 个品牌，每品牌：深底30 + 深底15 + 浅底30 + 浅底15。
const cellW = 190;
const cells = keys.map((key, i) => {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = 16 + col * cellW;
  const y = 16 + row * ROW_H;
  return `${tile(key, 30, x, y, true)}${tile(key, 15, x + 38, y + 15, true)}${tile(key, 30, x + 62, y, false)}${tile(key, 15, x + 100, y + 15, false)}<text x="${x + 124}" y="${y + 26}" font-size="11" fill="#333" font-family="system-ui">${key}</text>`;
}).join('');

const rows = Math.ceil(keys.length / COLS);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${32 + COLS * cellW}" height="${32 + rows * ROW_H}"><rect width="100%" height="100%" fill="#9aa2ad"/>${cells}</svg>`;
const out = join(HERE, '..', '..', 'demos', 'brand-logos-render.png');
await sharp(Buffer.from(svg), { density: 144 }).png().toFile(out);
console.log('已生成：' + out);
