// 用真实账本跑一遍**实际发布的聚合代码**（不是原型里的手写数字），
// 确认两级统计与原型一致。一次性验证脚本，不进 npm test。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'client.js'), 'utf8');

const React = {
  createElement: (t, p, ...c) => (typeof t === 'function' ? t({ ...(p ?? {}), children: c }) : { type: t, props: p ?? {}, children: c }),
  Fragment: Symbol('F'), useState: i => [typeof i === 'function' ? i() : i, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useMemo: f => f(), useRef: (i = null) => ({ current: i }),
  useCallback: f => f, memo: c => c,
};
global.window = { __ModuleLoader__: { load({ id, factory }) { if (id === 'dsh-model-picker-plus') global.__loaded = factory(n => (n === 'react' ? React : null)); } } };
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
global.document = { addEventListener: () => {}, removeEventListener: () => {}, body: {} };
const ls = new Map();
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };

await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
const { summarizeUsage, summarizeUsageByProvider } = global.__loaded.__test;

// 与 host 侧 snapshot 同样的解析：JSONL → 带 ok 标志的行
const lines = readFileSync('C:/Users/OY/.dsh/dsh-model-picker-plus/llm-usage.jsonl', 'utf8').split('\n').filter(Boolean);
const rows = [];
for (const line of lines) {
  let r; try { r = JSON.parse(line); } catch { continue; }
  if (!r || typeof r !== 'object') continue;
  rows.push({ ...r, ok: r.status === 'ok' || r.ok === true || (!r.error && r.reason !== 'error') });
}

const fT = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
// durationMs 是毫秒：先换算再格式化。上一版把毫秒当秒，打出 4459h 的鬼数字。
const fD = ms => { const s = ms / 1000; return s >= 3600 ? Math.floor(s / 3600) + 'h' + Math.round(s % 3600 / 60) + 'm'
  : s >= 60 ? Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's' : s.toFixed(1) + 's'; };
const pct = e => Math.round(e.successRate * 100) + '%';

console.log(`rows parsed = ${rows.length}\n`);
console.log('══ 第一层（厂商）══');
const l1 = summarizeUsageByProvider(rows).sort((a, b) => b.calls - a.calls);
for (const e of l1) {
  console.log(`  ${e.provider.padEnd(20)} ${String(e.calls).padStart(4)}次 ${fT(e.tokens).padStart(8)} ${fD(e.durationMs).padStart(7)} ${String(e.failed).padStart(3)}失败 ${pct(e).padStart(4)}  ${e.models.length}模型  ${e.topErrors.map(([c, n]) => c + '×' + n).join(' ') || '—'}`);
}
console.log(`  ${'TOTAL'.padEnd(20)} ${l1.reduce((s, e) => s + e.calls, 0)}次`);

for (const target of ['opencode2dsh', 'workbuddy-global']) {
  console.log(`\n══ 第二层（${target}）══`);
  const sub = summarizeUsage(rows.filter(r => r.provider === target)).sort((a, b) => b.calls - a.calls);
  for (const e of sub) {
    console.log(`  ${e.model.padEnd(34)} ${String(e.calls).padStart(4)}次 ${fT(e.tokens).padStart(8)} ${fD(e.durationMs).padStart(7)} ${String(e.failed).padStart(3)}失败 ${pct(e).padStart(4)}  avg=${fD(e.avgDurationMs)} avgTok=${e.avgTokens === null ? '—' : fT(e.avgTokens)}`);
  }
  const prov = l1.find(e => e.provider === target);
  const sum = sub.reduce((s, e) => s + e.calls, 0);
  console.log(`  一致性：厂商层 ${prov.calls} 次 = 模型层合计 ${sum} 次 → ${prov.calls === sum ? 'OK' : '*** MISMATCH ***'}`);
  console.log(`  一致性：厂商层 token ${prov.tokens} = 模型层合计 ${sub.reduce((s, e) => s + e.tokens, 0)} → ${prov.tokens === sub.reduce((s, e) => s + e.tokens, 0) ? 'OK' : '*** MISMATCH ***'}`);
}
