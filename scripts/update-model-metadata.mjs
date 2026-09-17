// 构建期元数据快照：多源合并（models.dev + OpenRouter + Hugging Face），
// 压缩后写入 client.js 的 __MODEL_METADATA_BEGIN__/END__ 标记块。
// 运行时插件零网络请求，纯本地查表。
//
// 失败策略（用户硬性要求：请求不到不要报错）：
// ① 每个数据源独立容错——哪家挂了只警告，其余照常合并；
// ② 全部失败或产物为空 → 保留 client.js 里的旧快照，exit 0；
// ③ 任何未预料异常 → 同样只警告 exit 0。打包/发布永不因此中断。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FETCH_TIMEOUT_MS = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'client.js');
const BEGIN = '// __MODEL_METADATA_BEGIN__';
const END = '// __MODEL_METADATA_END__';

const warn = (message) => console.warn(`[update-model-metadata] 警告：${message}`);

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-model-picker-plus' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// 模态压成单字符码：t=text i=image a=audio v=video p=pdf f=file。
const MODALITY_CODES = { text: 't', image: 'i', audio: 'a', video: 'v', pdf: 'p', file: 'f' };
const encodeModalities = (list) => {
  const codes = new Set();
  for (const item of list ?? []) {
    const code = MODALITY_CODES[String(item).toLowerCase()];
    if (code) codes.add(code);
  }
  return codes;
};

// 合并器：同一裸 id 跨源/跨厂家按“有就标”合并——模态取并集，
// 工具/推理/免费任一为真即真。宁多标勿漏标（漏标用户看不到能力，多标
// 至多胶囊多一枚；且同 id 撞名极少）。
function createMerger() {
  const map = new Map();
  const merge = (bareId, { input, tools, reasoning, free }) => {
    if (!bareId) return;
    const prev = map.get(bareId) ?? { i: new Set(), t: 0, r: 0, f: 0 };
    for (const code of input ?? []) prev.i.add(code);
    if (tools) prev.t = 1;
    if (reasoning) prev.r = 1;
    if (free) prev.f = 1;
    map.set(bareId, prev);
  };
  const finalize = () => {
    const out = new Map();
    for (const [id, signal] of map) {
      const i = [...signal.i].sort().join('');
      const entry = {
        i: i && i !== 't' ? i : undefined,
        t: signal.t ? 1 : undefined,
        r: signal.r ? 1 : undefined,
        f: signal.f ? 1 : undefined,
      };
      if (entry.i || entry.t || entry.r || entry.f) out.set(id, entry);
    }
    return out;
  };
  return { merge, finalize };
}

const bareIdOf = (id) => String(id ?? '').split('/').pop().toLowerCase();

// ── 数据源 ①：models.dev 全量库 ─────────────────────────────
async function sourceModelsDev(merge) {
  const catalog = await fetchJson('https://models.dev/api.json');
  let count = 0;
  for (const provider of Object.values(catalog)) {
    for (const model of Object.values(provider?.models ?? {})) {
      merge(bareIdOf(model?.id), {
        input: encodeModalities(model?.modalities?.input),
        tools: model?.tool_call === true,
        reasoning: model?.reasoning === true,
        free: typeof model?.cost?.input === 'number' && typeof model?.cost?.output === 'number'
          && model.cost.input === 0 && model.cost.output === 0,
      });
      count += 1;
    }
  }
  return count;
}

// ── 数据源 ②：OpenRouter 公开目录 ───────────────────────────
// architecture.input_modalities 给模态；supported_parameters 含
// tools / include_reasoning 给能力；pricing 全零给免费（:free 变体）。
async function sourceOpenRouter(merge) {
  const payload = await fetchJson('https://openrouter.ai/api/v1/models');
  let count = 0;
  for (const model of payload?.data ?? []) {
    const params = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
    const pricing = model?.pricing ?? {};
    const prompt = Number.parseFloat(String(pricing.prompt ?? 'NaN'));
    const completion = Number.parseFloat(String(pricing.completion ?? 'NaN'));
    merge(bareIdOf(model?.id), {
      input: encodeModalities(model?.architecture?.input_modalities),
      tools: params.includes('tools'),
      reasoning: params.includes('include_reasoning') || params.includes('reasoning'),
      free: Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0,
    });
    count += 1;
  }
  return count;
}

// ── 数据源 ③：Hugging Face Hub ──────────────────────────────
// 权重仓库，没有工具/推理/定价语义；只取 pipeline_tag 的视觉信号，
// 按下载量排序取头部（覆盖主流开放权重模型即可，它是补漏源不是主力）。
async function sourceHuggingFace(merge) {
  const payload = await fetchJson('https://huggingface.co/api/models?pipeline_tag=image-text-to-text&sort=downloads&direction=-1&limit=2000&fields=id');
  let count = 0;
  for (const model of Array.isArray(payload) ? payload : []) {
    merge(bareIdOf(model?.id), { input: new Set(['t', 'i']) });
    count += 1;
  }
  return count;
}

const SOURCES = [
  ['models.dev', sourceModelsDev],
  ['openrouter', sourceOpenRouter],
  ['huggingface', sourceHuggingFace],
];

async function main() {
  const { merge, finalize } = createMerger();
  const report = [];
  let succeeded = 0;
  for (const [name, run] of SOURCES) {
    try {
      const count = await run(merge);
      report.push(`${name} ${count} 条`);
      succeeded += 1;
    } catch (error) {
      warn(`${name} 拉取失败：${error?.message ?? error}（跳过该源，用其余源继续）`);
    }
  }
  if (succeeded === 0) {
    warn('所有数据源都失败，保留旧快照');
    process.exit(0);
  }

  const map = finalize();
  if (map.size === 0) {
    warn('合并结果为空，疑似上游格式变化，保留旧快照');
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
    warn('client.js 缺少 __MODEL_METADATA__ 标记块，请先手工加入');
    process.exit(0);
  }

  const generatedAt = new Date().toISOString().slice(0, 10);
  const entries = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, signal]) => `${JSON.stringify(id)}:${JSON.stringify(signal)}`)
    .join(',');
  const block = `${BEGIN}（由 scripts/update-model-metadata.mjs 生成于 ${generatedAt}，来源：${report.join(' + ')}，请勿手改）
    const MODEL_METADATA_AT = '${generatedAt}';
    const MODEL_METADATA = {${entries}};
    ${END}`;

  const next = `${source.slice(0, beginIndex)}${block}${source.slice(endIndex + END.length)}`;
  try {
    writeFileSync(CLIENT_PATH, next);
  } catch (error) {
    warn(`写回 client.js 失败：${error?.message ?? error}`);
    process.exit(0);
  }
  console.log(`[update-model-metadata] 完成：${report.join('，')} → ${map.size} 个有能力信号，快照日期 ${generatedAt}，块大小 ${(block.length / 1024).toFixed(1)}KB`);
}

main().catch((error) => {
  // 双保险：任何未预料的异常也不允许以非零码退出。
  warn(`未预料错误：${error?.message ?? error}`);
  process.exit(0);
});
