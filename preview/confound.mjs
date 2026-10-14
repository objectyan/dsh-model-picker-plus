import fs from 'node:fs';

const lines = fs.readFileSync('C:/Users/OY/.dsh/dsh-model-picker-plus/llm-usage.jsonl', 'utf8')
  .split('\n').filter(Boolean);
const rows = [];
for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; } if (r && typeof r === 'object' && r.startedAt) rows.push(r); }

const hourOf = r => new Date(r.startedAt - (r.timezoneOffsetMinutes ?? new Date(r.startedAt).getTimezoneOffset()) * 60000).getUTCHours();

// 混淆检查：整体「下午差」可能只是「下午恰好在用那个爱失败的模型」。
// 所以按模型分别看时段成功率，只有**同一模型内部**也下午差，才是时段效应。
const byModel = new Map();
for (const r of rows) {
  const k = `${r.provider}/${r.model}`;
  const m = byModel.get(k) ?? new Map();
  const b = m.get(hourOf(r)) ?? { calls: 0, ok: 0 };
  b.calls++; if (r.ok) b.ok++;
  m.set(hourOf(r), b); byModel.set(k, m);
}

const fmt = (h) => `${String(h).padStart(2, '0')}:00`;
for (const [k, m] of [...byModel.entries()].sort((a, b) => {
  const ca = [...a[1].values()].reduce((s, v) => s + v.calls, 0);
  const cb = [...b[1].values()].reduce((s, v) => s + v.calls, 0);
  return cb - ca;
})) {
  const buckets = [...m.entries()].sort((a, b) => a[0] - b[0]).filter(([, v]) => v.calls >= 8);
  if (buckets.length < 3) continue;
  const total = [...m.values()].reduce((s, v) => s + v.calls, 0);
  console.log(`\n${k}  (${total} 次)`);
  const rates = buckets.map(([h, v]) => ({ h, r: v.ok / v.calls, c: v.calls }));
  for (const { h, r, c } of rates) {
    const bar = '█'.repeat(Math.round(r * 20)).padEnd(20, '·');
    console.log(`  ${fmt(h)} ${bar} ${String(Math.round(r * 100)).padStart(3)}%  ${String(c).padStart(3)}次`);
  }
  const best = rates.reduce((a, b) => (b.r > a.r ? b : a));
  const worst = rates.reduce((a, b) => (b.r < a.r ? b : a));
  const spread = Math.round((best.r - worst.r) * 100);
  console.log(`  → 同一模型内部时段差 ${spread}%（${fmt(worst.h)} ${Math.round(worst.r * 100)}% ↔ ${fmt(best.h)} ${Math.round(best.r * 100)}%）`);
}
