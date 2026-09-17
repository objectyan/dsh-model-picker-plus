// 生成矢量化图标预览页：徽章尺寸 + 放大对比，深浅两底。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
const match = source.match(/const BRAND_ICON_EXTRAS = \{([\s\S]*?)\};/);
if (!match) throw new Error('找不到 BRAND_ICON_EXTRAS 块');
const extras = new Function(`return {${match[1]}};`)();

const NAMES = {
  zhipu: '智谱 / Z.ai（GLM）',
  sensenova: '商汤 SenseNova',
  stepfun: '阶跃星辰 StepFun',
  yi: '零一万物 Yi',
  baichuan: '百川 Baichuan',
  internlm: '书生 InternLM',
};

const badge = (key, size, dark) => {
  const icon = extras[key];
  const bg = dark ? '#2a2d34' : '#f3f4f6';
  const fg = dark ? '#aab4c8' : '#4b5563';
  return `<span style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.3)}px;background:${bg};color:${fg};display:inline-flex;align-items:center;justify-content:center;">
    <svg viewBox="0 0 ${icon.w} ${icon.h}" width="${Math.round(size * 0.62)}" height="${Math.round(size * 0.62)}" fill="currentColor" preserveAspectRatio="xMidYMid meet"><path d="${icon.d}" fill-rule="evenodd"/></svg>
  </span>`;
};

const rows = Object.keys(extras).map(key => `
  <tr>
    <td>${NAMES[key] ?? key}<br><small>${extras[key].w}×${extras[key].h} · ${extras[key].d.length} 字符</small></td>
    <td>${badge(key, 30, true)} ${badge(key, 22, true)} ${badge(key, 15, true)}</td>
    <td>${badge(key, 30, false)} ${badge(key, 22, false)} ${badge(key, 15, false)}</td>
    <td style="background:#2a2d34;color:#aab4c8;"><svg viewBox="0 0 ${extras[key].w} ${extras[key].h}" width="80" height="80" fill="currentColor"><path d="${extras[key].d}" fill-rule="evenodd"/></svg></td>
  </tr>`).join('');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>品牌图标矢量化预览</title>
<style>body{font:14px/1.6 system-ui;background:#e5e7eb;color:#111;padding:24px}table{border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}td,th{padding:12px 16px;border-bottom:1px solid #eee;vertical-align:middle}th{text-align:left;background:#f9fafb}span{vertical-align:middle;margin-right:6px}</style></head><body>
<h1>HF 头像 → SVG 矢量化预览（最终收录版）</h1>
<p>三档徽章尺寸（30 / 22 / 15px）× 深浅两底，最后一列放大看细节。
零一万物（横向字标）、阶跃星辰（渐变圆底）、书生（吉祥物插画）实测 15px 不合格，已淘汰回字母兜底。</p>
<table><tr><th>厂家</th><th>深底</th><th>浅底</th><th>放大</th></tr>${rows}</table>
</body></html>`;

const out = join(HERE, '..', '..', 'demos', 'brand-icons-preview.html');
writeFileSync(out, html);
console.log('已生成：' + out);
