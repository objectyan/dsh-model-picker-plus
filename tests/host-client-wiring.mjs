// host↔client 链路端到端验证：
// host 侧 apply() 提供 modelPickerUsage.summarize() → client 侧 readUsageIndex
// 通过 remote 拿到它 → usageBadge 命中 → 渲染出用量胶囊。
// 这是「界面到底显不显示用量」的关键一环，此前只有纯函数单测，没有跨端验证。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, readLedger } from '../index.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('== host 提供 summarize，client 能取到 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-wire-'));
  try {
    const provided = {};
    const ctx = {
      get: (key) => (key === 'storage' ? { dataDir: dir } : undefined),
      logger: { warn: () => {} },
      provide: (key, value) => { provided[key] = value; },
      on: () => {},
    };
    apply(ctx);

    // 模拟 host 真实记账：写两条明细。
    const ledgerDir = join(dir, 'dsh-model-picker-plus');
    const { appendFileSync } = await import('node:fs');
    const rows = [
      { provider: 'deepseek', model: 'deepseek-v4-pro', sessionId: 's1', ok: true, durationMs: 1200, inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, startedAt: 1000, endedAt: 2200 },
      { provider: 'deepseek', model: 'deepseek-v4-pro', sessionId: 's1', ok: false, durationMs: 800, inputTokens: 30, startedAt: 3000, endedAt: 3800 },
    ];
    for (const row of rows) appendFileSync(join(ledgerDir, 'llm-usage.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');

    check('host 暴露了 summarize', typeof provided.modelPickerUsage?.summarize === 'function');
    const index = provided.modelPickerUsage.summarize();
    check('汇总含该 provider/model 的条目', index['deepseek/deepseek-v4-pro']?.calls === 2,
      JSON.stringify(index['deepseek/deepseek-v4-pro']));

    // client 侧的读取器逻辑（与 client.js readUsageIndexInternal 同形）：
    // 直接对象 → 返回；{ ok, value } 包壳 → ok 时解包；异常 → null。
    const readUsageIndex = (svc) => {
      try {
        const result = svc?.summarize?.();
        if (result && typeof result === 'object' && 'ok' in result) {
          return result.ok === true && result.value && typeof result.value === 'object' ? result.value : null;
        }
        return result && typeof result === 'object' ? result : null;
      } catch {
        return null;
      }
    };
    const viaDirect = readUsageIndex(provided.modelPickerUsage);
    // summarize() 每次重新聚合，返回的是新对象——必须深比较，不能用引用相等。
    check('client 能取到汇总（直返形态）',
      viaDirect !== null && viaDirect['deepseek/deepseek-v4-pro']?.calls === 2
      && viaDirect['deepseek/deepseek-v4-pro']?.okCalls === 1
      && viaDirect['deepseek/deepseek-v4-pro']?.failedCalls === 1,
      JSON.stringify(viaDirect));

    const viaEnvelope = readUsageIndex({ summarize: () => ({ ok: true, value: index }) });
    check('client 能解析 RPC 包壳形态', viaEnvelope === index);

    const viaFail = readUsageIndex({ summarize: () => ({ ok: false, error: 'boom' }) });
    check('RPC 报错时 client 返回 null（不显示用量）', viaFail === null);

    const viaThrow = readUsageIndex({ summarize: () => { throw new Error('nope'); } });
    check('RPC 抛错时 client 返回 null', viaThrow === null);

    check('账本本身可读回', readLedger(ledgerDir).length === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');