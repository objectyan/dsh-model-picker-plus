// 构建期品牌图标补位：抓 Hugging Face 组织头像，potrace 矢量化成单色 SVG，
// 写进 client.js 的 __BRAND_ICON_EXTRA_BEGIN__/END__ 生成块。
// 只补 simple-icons 没有的厂家；转完随徽章 currentColor 主题化。
//
// 失败策略（硬性要求：请求不到不要报错）：
// 单个厂家失败只警告跳过；全部失败或产物为空 → 保留旧块，exit 0。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const potrace = require('potrace');
const sharp = require('sharp');

const FETCH_TIMEOUT_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'client.js');
const BEGIN = '// __BRAND_ICON_EXTRA_BEGIN__';
const END = '// __BRAND_ICON_EXTRA_END__';

const warn = (message) => console.warn(`[update-brand-icons] 警告：${message}`);

// simple-icons 缺位的厂家 → HF 组织名（头像即官方 logo）。
// 只收“单色化后在 15px 徽章里仍可辨识”的标：
// yi（横向字标）、stepfun（渐变圆底）、internlm（吉祥物插画）实测不合格，字母兜底。
// threshold 为空走自动阈值；商汤风车是多彩标，提高阈值把亮绿块也描进来保轮廓。
const ORG_MAP = {
  zhipu: { org: 'zai-org' },                    // 智谱 / Z.ai（GLM 系列）
  sensenova: { org: 'SenseNova', threshold: 215 }, // 商汤
  baichuan: { org: 'baichuan-inc' },            // 百川
  xai: { org: 'xai-org' },                      // xAI（Grok）
  cohere: { org: 'CohereLabs' },                // Cohere（Command 系列）
  groq: { org: 'groq' },                        // Groq 推理平台
  hunyuan: { org: 'Tencent-Hunyuan' },          // 腾讯混元
};

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-model-picker-plus' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// sharp 解码（HF CDN 统一给 WebP，扩展名不可信），统一缩到 256 内再描边。
async function decodeImage(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

// 与 potrace 内部一致：透明区域先合成到白底再算亮度
// （否则透明角点会被当成黑底，反色方向判断反、描出实心方块）。
const luminanceAt = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  const alpha = image.data[offset + 3] / 255;
  const lum = image.data[offset] * 0.299 + image.data[offset + 1] * 0.587 + image.data[offset + 2] * 0.114;
  return 255 + (lum - 255) * alpha;
};

// 角点采样判断底色：背景亮 → 描黑，背景暗 → 反色描白。
function detectBrightBackground(image) {
  const corners = [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]];
  const sum = corners.reduce((total, [x, y]) => total + luminanceAt(image, x, y), 0);
  return sum / corners.length > 128;
}

// potrace 的 _processLoadedImage 只需要 Jimp 形状的对象
// （bitmap.{width,height,data} + scan 回调），绕过 loadImage 直接喂，
// 彻底避开 potrace 捆绑 jimp 的 API 不兼容。反色交给 blackOnWhite 参数。
function trace(image, brightBackground, threshold) {
  const fakeJimp = {
    bitmap: { width: image.width, height: image.height, data: image.data },
    scan(x0, y0, w, h, callback) {
      for (let y = y0; y < y0 + h; y += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
          callback(x, y, (y * image.width + x) * 4);
        }
      }
    },
  };
  return new Promise((resolve, reject) => {
    try {
      const instance = new potrace.Potrace();
      instance.setParameters({
        threshold: threshold ?? potrace.Potrace.THRESHOLD_AUTO,
        turdSize: 4,         // 丢弃噪点小斑块
        optTolerance: 0.3,   // 曲线平滑容差（大一点点，path 更短）
        blackOnWhite: brightBackground,
      });
      instance._processLoadedImage(fakeJimp);
      resolve(instance.getSVG(1));
    } catch (error) {
      reject(error);
    }
  });
}

// 从 potrace 的 SVG 输出里抽 path 数据和坐标空间。
function extractPaths(svg, fallbackSize = 24) {
  const paths = [...svg.matchAll(/ d="([^"]+)"/g)].map(match => match[1]);
  if (paths.length === 0) return null;
  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  const sizeAttr = svg.match(/width="([\d.]+)(?:pt|px)?"[^>]*height="([\d.]+)(?:pt|px)?"/);
  const w = Number(viewBox?.[1] ?? sizeAttr?.[1] ?? fallbackSize);
  const h = Number(viewBox?.[2] ?? sizeAttr?.[2] ?? fallbackSize);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { d: paths.join(' '), w: Math.round(w), h: Math.round(h) };
}

async function main() {
  const results = {};
  let succeeded = 0;
  for (const [key, spec] of Object.entries(ORG_MAP)) {
    const { org, threshold } = spec;
    try {
      const meta = await fetchBuffer(`https://huggingface.co/api/organizations/${org}/avatar`);
      const { avatarUrl } = JSON.parse(meta.toString('utf8'));
      if (!avatarUrl) throw new Error('组织无头像');
      const image = await decodeImage(await fetchBuffer(avatarUrl));
      const bright = detectBrightBackground(image);
      const svg = await trace(image, bright, threshold);
      const extracted = extractPaths(svg, Math.max(image.width, image.height));
      if (!extracted) throw new Error('矢量化结果为空');
      results[key] = extracted;
      succeeded += 1;
      console.log(`[update-brand-icons] ${key} ← ${org} ✓（${extracted.w}×${extracted.h}，${extracted.d.length} 字符）`);
    } catch (error) {
      warn(`${key}（${org}）失败：${error?.message ?? error}（跳过，该厂家继续字母兜底）`);
    }
  }
  if (succeeded === 0) {
    warn('所有厂家都失败，保留旧图标块');
    process.exit(0);
  }

  let source;
  try {
    source = readFileSync(CLIENT_PATH, 'utf8');
  } catch (error) {
    warn(`读取 client.js 失败：${error?.message ?? error}`);
    process.exit(0);
  }
  const beginIndex = source.indexOf(BEGIN);
  const endIndex = source.indexOf(END);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    warn('client.js 缺少 __BRAND_ICON_EXTRA__ 标记块，请先手工加入');
    process.exit(0);
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const entries = Object.entries(results)
    .map(([key, icon]) => `${JSON.stringify(key)}:${JSON.stringify(icon)}`)
    .join(',');
  const block = `${BEGIN}（由 scripts/update-brand-icons.mjs 生成于 ${generatedAt}，HF 头像矢量化，请勿手改）
    const BRAND_ICON_EXTRAS = {${entries}};
    ${END}`;

  const next = `${source.slice(0, beginIndex)}${block}${source.slice(endIndex + END.length)}`;
  try {
    writeFileSync(CLIENT_PATH, next);
  } catch (error) {
    warn(`写回 client.js 失败：${error?.message ?? error}`);
    process.exit(0);
  }
  console.log(`[update-brand-icons] 完成：${succeeded}/${Object.keys(ORG_MAP).length} 个厂家矢量化，块大小 ${(block.length / 1024).toFixed(1)}KB`);
}

main().catch((error) => {
  warn(`未预料错误：${error?.message ?? error}`);
  process.exit(0);
});
