// 渲染全部品牌的【生效徽章】全家福：官方标 > simple-icons > 矢量化 > 字母。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const grab = (name) => {
  const m = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`));
  return m ? new Function(`return {${m[1]}};`)() : {};
};
const LOGOS = grab('BRAND_LOGOS');
const PATHS = grab('BRAND_ICON_PATHS');
const EXTRAS = grab('BRAND_ICON_EXTRAS');

// 生效优先级：官方标 > simple-icons > 矢量化。
const effective = (key) => (LOGOS[key] ? '官方' : PATHS[key] ? 'simple' : EXTRAS[key] ? '矢量化' : null);
const allKeys = [...new Set([...Object.keys(LOGOS), ...Object.keys(PATHS), ...Object.keys(EXTRAS)])].sort();
const groups = { '官方': [], 'simple': [], '矢量化': [] };
for (const key of allKeys) groups[effective(key)].push(key);

const tile = (key, size, x, y, dark) => {
  const r = Math.round(size * 0.3);
  const inner = Math.round(size * 0.62);
  const pad = (size - inner) / 2;
  const bg = dark ? '#2a2d34' : '#f3f4f6';
  const fg = dark ? '#aab4c8' : '#4b5563';
  let glyph;
  if (LOGOS[key]) {
    glyph = `<svg x="${x + pad}" y="${y + pad}" width="${inner}" height="${inner}" viewBox="${LOGOS[key].vb}" fill="currentColor" color="${fg}" preserveAspectRatio="xMidYMid meet">${LOGOS[key].s}</svg>`;
  } else if (PATHS[key]) {
    glyph = `<svg x="${x + pad}" y="${y + pad}" width="${inner}" height="${inner}" viewBox="0 0 24 24"><path d="${PATHS[key]}" fill="${fg}"/></svg>`;
  } else {
    const e = EXTRAS[key];
    glyph = `<svg x="${x + pad}" y="${y + pad}" width="${inner}" height="${inner}" viewBox="0 0 ${e.w} ${e.h}"><path d="${e.d}" fill="${fg}" fill-rule="evenodd"/></svg>`;
  }
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" fill="${bg}"/>${glyph}`;
};

const COLS = 6;
const CELL_W = 210;
const CELL_H = 52;
const SECTION_H = 34;
let y = 16;
const parts = [];
for (const [tier, keys] of Object.entries(groups)) {
  parts.push(`<text x="16" y="${y + 16}" font-size="14" font-weight="700" fill="#1f2937" font-family="system-ui">${tier === '官方' ? '① models.dev 官方标' : tier === 'simple' ? '② simple-icons' : '③ HF 矢量化'}（${keys.length} 个）</text>`);
  y += SECTION_H;
  keys.forEach((key, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = 16 + col * CELL_W;
    const cy = y + row * CELL_H;
    parts.push(`${tile(key, 30, x, cy, true)}${tile(key, 15, x + 38, cy + 15, true)}${tile(key, 30, x + 62, cy, false)}${tile(key, 15, x + 100, cy + 15, false)}<text x="${x + 126}" y="${cy + 25}" font-size="11" fill="#333" font-family="system-ui">${key}</text>`);
  });
  y += Math.ceil(keys.length / COLS) * CELL_H + 10;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${32 + COLS * CELL_W}" height="${y}"><rect width="100%" height="100%" fill="#e5e7eb"/>${parts.join('')}</svg>`;
const out = join(HERE, '..', '..', 'demos', 'all-brands-render.png');
await sharp(Buffer.from(svg), { density: 144 }).png().toFile(out);
console.log(`已生成：${out}（官方 ${groups['官方'].length} + simple ${groups['simple'].length} + 矢量化 ${groups['矢量化'].length} = ${allKeys.length}）`);
