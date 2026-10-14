import fs from 'node:fs';

const lines = fs.readFileSync('C:/Users/OY/.dsh/dsh-model-picker-plus/llm-usage.jsonl', 'utf8')
  .split('\n').filter(Boolean);
const rows = [];
for (const l of lines) { let r; try { r = JSON.parse(l); } catch { continue; } if (r && typeof r === 'object' && r.startedAt) rows.push(r); }

// 与 client.js 同口径：本地 = startedAt - offset*60000（getTimezoneOffset 是 UTC 减本地）
const hourOf = r => new Date(r.startedAt - (r.timezoneOffsetMinutes ?? new Date(r.startedAt).getTimezoneOffset()) * 60000).getUTCHours();

const target = process.argv[2] ?? 'opencode2dsh';
const sub = rows.filter(r => r.provider === target);
const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, ok: 0, failed: 0 }));
for (const r of sub) { const b = buckets[hourOf(r)]; b.calls++; if (r.ok) b.ok++; else b.failed++; }

const max = Math.max(...buckets.map(b => b.calls)) || 1;
console.log(`provider=${target}  rows=${sub.length}  hourMax=${max}\n`);
console.log('hour  calls  ok fail  rate   barPct  okPct failPct   html');
for (const b of buckets) {
  const rate = b.calls ? Math.round(b.ok / b.calls * 100) : null;
  const h = Math.max(b.calls ? 4 : 2, Math.round((b.calls / max) * 100));
  const okPct = b.calls ? Math.round(b.ok / b.calls * 100) : 0;
  const flag = b.calls >= 20 ? '' : '  (样本<20，不参与结论)';
  console.log(`${String(b.hour).padStart(2, '0')}   ${String(b.calls).padStart(4)} ${String(b.ok).padStart(4)} ${String(b.failed).padStart(4)} ${String(rate ?? '-').padStart(5)} ${String(h).padStart(5)}% ${String(okPct).padStart(5)}% ${String(100 - okPct).padStart(6)}%   ${'<i style="height:' + h + '%"><b class="r" style="flex-grow:' + b.failed + '"></b><b class="g" style="flex-grow:' + b.ok + '"></b></i>'}${flag}`);
}

// 结论行：与 hourExtremes 同规则（>=20 且差距 >=10 个百分点）
const usable = buckets.filter(b => b.calls >= 20);
if (usable.length >= 2) {
  const sorted = usable.slice().sort((a, b) => a.ok / a.calls - b.ok / b.calls);
  const worst = sorted[0], best = sorted[sorted.length - 1];
  const gap = Math.round((best.ok / best.calls - worst.ok / worst.calls) * 100);
  console.log(`\n结论：${gap >= 10 ? '显示' : '不显示（差距仅 ' + gap + '%）'}  最好 ${String(best.hour).padStart(2, '0')}:00 ${Math.round(best.ok / best.calls * 100)}% · 最差 ${String(worst.hour).padStart(2, '0')}:00 ${Math.round(worst.ok / worst.calls * 100)}%  (gap ${gap}%)`);
} else {
  console.log(`\n结论：不显示（达标时段不足 ${usable.length} 个）`);
}
