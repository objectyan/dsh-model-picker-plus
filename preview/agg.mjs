import fs from 'node:fs';

const lines = fs.readFileSync('C:/Users/OY/.dsh/dsh-model-picker-plus/llm-usage.jsonl', 'utf8')
  .split('\n').filter(Boolean);

const agg = () => ({ calls: 0, ok: 0, tok: 0, ms: 0, errs: new Map() });
const P = new Map();
for (const line of lines) {
  let r; try { r = JSON.parse(line); } catch { continue; }
  if (!r || typeof r !== 'object' || !r.provider || !r.model) continue;
  const ok = r.status === 'ok' || r.ok === true || (!r.error && r.reason !== 'error');
  const p = P.get(r.provider) ?? (P.set(r.provider, { ...agg(), models: new Map() }), P.get(r.provider));
  const m = p.models.get(r.model) ?? p.models.set(r.model, agg()).get(r.model);
  for (const t of [p, m]) {
    t.calls++; if (ok) t.ok++;
    const tok = Number(r.totalTokens ?? (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0)
      + (Number(r.cacheReadTokens) || 0) + (Number(r.cacheWriteTokens) || 0));
    if (Number.isSafeInteger(tok)) t.tok += tok;
    const ms = Number(r.durationMs); if (Number.isFinite(ms) && ms >= 0) t.ms += ms;
  }
  if (!ok) { const code = r.error?.code ?? r.code ?? 'UNKNOWN'; p.errs.set(code, (p.errs.get(code) ?? 0) + 1); }
}

const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const fmtDur = s => s >= 3600 ? Math.floor(s / 3600) + 'h' + Math.round(s % 3600 / 60) + 'm'
  : s >= 60 ? Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's' : s.toFixed(0) + 's';
const topErr = e => [...e.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).slice(0, 2).join(' ') || '—';

for (const [name, p] of [...P.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
  const rate = Math.round(p.ok / p.calls * 100);
  console.log(`\n${name}  ${p.calls}次 ${p.ok}ok ${p.calls - p.ok}fail ${rate}%  ${fmtTok(p.tok)} ${fmtDur(p.ms / 1000)}  err:${topErr(p.errs)}`);
  for (const [mn, m] of [...p.models.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    const mr = Math.round(m.ok / m.calls * 100);
    console.log(`    ${mn.padEnd(34)}${String(m.calls).padStart(4)}次 ${String(m.ok).padStart(4)}ok `
      + `${String(m.calls - m.ok).padStart(4)}fail ${String(mr).padStart(4)}%  ${fmtTok(m.tok).padStart(8)} ${fmtDur(m.ms / 1000).padStart(7)}`);
  }
}
