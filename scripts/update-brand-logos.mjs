// 构建期品牌官方标抓取：models.dev /logos/{slug}.svg 是官方单色矢量标
// （fill="currentColor"，深底浅底自适应），抓回内嵌进 client.js 的
// __BRAND_LOGO_BEGIN__/END__ 生成块。优先级高于 simple-icons 手工表和
// HF 矢量化补位。
//
// 注意：models.dev 对没有 logo 的厂家返回同一个占位符 SVG（1421 字节），
// 脚本先抓占位符指纹做比对，假货直接跳过（回退到下级图标源）。
//
// 失败策略（硬性要求：请求不到不要报错）：
// 单个品牌失败只警告跳过；全部失败或产物为空 → 保留旧块，exit 0。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FETCH_TIMEOUT_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'client.js');
const BEGIN = '// __BRAND_LOGO_BEGIN__';
const END = '// __BRAND_LOGO_END__';

const warn = (message) => console.warn(`[update-brand-logos] 警告：${message}`);

// 品牌键 → models.dev 厂家 slug。只收“该 slug 的标就是这个品牌的官方标”
// 的组合（比如字节不收 volcengine 火山子品牌标，继续用 simple-icons 的字节标）。
const LOGO_MAP = {
  deepseek: 'deepseek',
  openai: 'openai',
  anthropic: 'anthropic',
  googlegemini: 'google',
  meta: 'meta',
  mistralai: 'mistral',
  alibabacloud: 'alibaba',
  kimi: 'moonshotai',
  minimax: 'minimax',
  nvidia: 'nvidia',
  zhipu: 'zai',
  xai: 'xai',
  cohere: 'cohere',
  groq: 'groq',
  sensenova: 'sensenova',
  stepfun: 'stepfun',
  openrouter: 'openrouter',
  opencode: 'opencode',
  perplexity: 'perplexity',
  huggingface: 'huggingface',
  lmstudio: 'lmstudio',
  bedrock: 'amazon-bedrock',
  azure: 'azure',
  togetherai: 'togetherai',
  cerebras: 'cerebras',
  vercel: 'vercel',
};

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-model-picker-plus' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// 从完整 SVG 里抽 viewBox 和内部标记（多 path/rect/circle 原样保留）。
function extractLogo(svg) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  const openEnd = svg.indexOf('>');
  const closeStart = svg.lastIndexOf('</svg>');
  if (!viewBox || openEnd === -1 || closeStart <= openEnd) return null;
  const inner = svg.slice(openEnd + 1, closeStart).trim();
  // 必须带 currentColor（否则不是主题自适应的单色标，不入库）。
  if (!inner || !inner.includes('currentColor')) return null;
  return { s: inner, vb: viewBox };
}

async function main() {
  // 占位符指纹：models.dev 对无 logo 厂家统一返回它（用一个已知占位 slug）。
  let placeholder = null;
  try {
    placeholder = await fetchText('https://models.dev/logos/zhipu.svg');
  } catch (error) {
    warn(`占位符指纹拉取失败：${error?.message ?? error}（无法辨假，保留旧块）`);
    process.exit(0);
  }

  const results = {};
  let succeeded = 0;
  for (const [key, slug] of Object.entries(LOGO_MAP)) {
    try {
      const svg = await fetchText(`https://models.dev/logos/${slug}.svg`);
      if (svg === placeholder) throw new Error('models.dev 暂无官方标（占位符）');
      const logo = extractLogo(svg);
      if (!logo) throw new Error('SVG 结构不符合预期（无 viewBox/currentColor）');
      results[key] = logo;
      succeeded += 1;
      console.log(`[update-brand-logos] ${key} ← ${slug} ✓（${logo.vb}，${logo.s.length} 字符）`);
    } catch (error) {
      warn(`${key}（${slug}）：${error?.message ?? error}（回退下级图标源）`);
    }
  }
  if (succeeded === 0) {
    warn('所有品牌都失败，保留旧官方标块');
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
    warn('client.js 缺少 __BRAND_LOGO__ 标记块，请先手工加入');
    process.exit(0);
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const entries = Object.entries(results)
    .map(([key, logo]) => `${JSON.stringify(key)}:${JSON.stringify(logo)}`)
    .join(',');
  const block = `${BEGIN}（由 scripts/update-brand-logos.mjs 生成于 ${generatedAt}，models.dev 官方标，请勿手改）
    const BRAND_LOGOS = {${entries}};
    ${END}`;

  const next = `${source.slice(0, beginIndex)}${block}${source.slice(endIndex + END.length)}`;
  try {
    writeFileSync(CLIENT_PATH, next);
  } catch (error) {
    warn(`写回 client.js 失败：${error?.message ?? error}`);
    process.exit(0);
  }
  console.log(`[update-brand-logos] 完成：${succeeded}/${Object.keys(LOGO_MAP).length} 个官方标入库，块大小 ${(block.length / 1024).toFixed(1)}KB`);
}

main().catch((error) => {
  warn(`未预料错误：${error?.message ?? error}`);
  process.exit(0);
});
