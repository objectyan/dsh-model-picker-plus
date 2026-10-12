// 用真实账本跑一遍读取与聚合（验证跨端链路所用的纯函数在真实数据上成立）。
import { readLedger, buildUsageIndex } from '../usage-host.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir = join(homedir(), '.dsh', 'dsh-model-picker-plus');
const rows = readLedger(dir);
console.log('真实账本行数:', rows.length);
const agg = buildUsageIndex(rows);
for (const [key, v] of Object.entries(agg)) {
  console.log(`  ${key}: calls=${v.calls} ok=${v.okCalls} fail=${v.failedCalls}`
    + ` tokens=${v.tokens} (exact=${v.tokensExact}) dur=${Math.round(v.durationMs / 1000)}s`
    + ` sessions=${Object.keys(v.sessions).length}`);
}
console.log('带 requestId 的行:', rows.filter(r => r.requestId).length, '/', rows.length);
console.log('含 usage 的行:', rows.filter(r => r.usageReported || r.inputTokens !== undefined).length);
