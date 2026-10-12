// 跨端链路验证：host 采集 → RPC 快照 → client 读取 → 徽章命中。
// 之前这里只模拟了一个同步读取函数，证明不了浏览器真能拿到数据；
// 现在按真实协议走：host 用 registerUsageRpc 注册 handler，
// client 用 requestUsageSnapshot 经 connection.rpc.call 取回。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord, buildUsageIndex, readLedger, registerUsageRpc, RPC_NAMESPACE } from '../usage-host.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** client 侧读取器（与 client.js requestUsageSnapshot 同形）。 */
async function requestUsageSnapshot(rpc, payload = {}, signal) {
  if (!rpc || typeof rpc.call !== 'function') throw new Error('Usage RPC connection unavailable');
  const result = await rpc.call('/api', 'model-picker-plus-usage/snapshot', payload, signal);
  if (!result?.ok) throw new Error(result?.error?.message ?? 'Usage RPC failed');
  const value = result.value;
  if (!value || value.schemaVersion !== 2 || !value.models || !Array.isArray(value.recent)) {
    throw new Error('Invalid usage response');
  }
  return value;
}

/** 按真实协议接线：host 用 fetch.register 注册精确路由，client 经 /api 调它。 */
function wire(service) {
  let path = null;
  let route = null;
  const connection = { fetch: { register: (spec) => { path = spec.path; route = spec; return () => {}; } } };
  registerUsageRpc(connection, service);
  return {
    rpc: {
      call: async (channel, method, payload, signal) => {
        if (channel !== '/api') throw new Error(`unexpected channel ${channel}`);
        if (path !== `/api/${method}`) throw new Error(`unmatched route ${method}`);
        // 按真实信封走一遍 route.fetch，确保两端协议一致。
        const request = {
          headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
          json: async () => ({ type: 'client-request', rpcId: 'wire-1', method, payload }),
          signal,
        };
        const response = await route.fetch(request);
        const body = await response.json();
        return body.result;
      },
    },
  };
}

console.log('== 端到端：host 记账 → RPC → client 读到 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-wire-'));
  try {
    appendRecord(dir, {
      provider: 'deepseek', model: 'deepseek-v4-pro', sessionId: 's1', requestId: 'r1',
      ok: true, durationMs: 1200, timeToFirstTokenMs: 300, inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 500, usageReported: true, startedAt: 1000, endedAt: 2200,
    });
    appendRecord(dir, {
      provider: 'deepseek', model: 'deepseek-v4-pro', sessionId: 's1', requestId: 'r2',
      ok: false, durationMs: 800, inputTokens: 30, usageReported: true, startedAt: 3000, endedAt: 3800,
    });

    const service = {
      snapshot: (query = {}) => {
        const records = readLedger(dir).filter(r => (!query.sessionId || r.sessionId === query.sessionId)
          && (!query.provider || r.provider === query.provider) && (!query.model || r.model === query.model));
        return {
          schemaVersion: 2, models: buildUsageIndex(records),
          recent: records.slice(-(query.limit ?? 100)).reverse(),
          status: { collecting: true, persistedCalls: records.length, writeErrors: 0, recordCount: records.length },
        };
      },
    };
    const { rpc } = wire(service);

    const snapshot = await requestUsageSnapshot(rpc, { limit: 100 });
    const entry = snapshot.models['deepseek/deepseek-v4-pro'];
    check('client 经 RPC 取到汇总', entry?.calls === 2, JSON.stringify(entry));
    check('汇总区分成功/失败', entry.okCalls === 1 && entry.failedCalls === 1);
    check('汇总累加 token 与耗时', entry.tokens === 650 && entry.durationMs === 2000,
      `tokens=${entry.tokens} dur=${entry.durationMs}`);
    check('汇总带采集状态（可判定是否已开始采集）', snapshot.status.collecting === true);
    check('recent 返回逐请求明细（含耗时）', snapshot.recent[0]?.durationMs !== undefined);

    // 按会话过滤：跨会话的数据不得串味。
    const scoped = await requestUsageSnapshot(rpc, { sessionId: 'other' });
    check('按 sessionId 过滤生效', Object.keys(scoped.models).length === 0,
      JSON.stringify(scoped.models));

    // 按模型过滤。
    const byModel = await requestUsageSnapshot(rpc, { provider: 'deepseek', model: 'deepseek-v4-pro' });
    check('按 provider/model 过滤生效', byModel.models['deepseek/deepseek-v4-pro']?.calls === 2);

    // 降级：RPC 抛错时 client 明确失败，界面据此不显示用量（而非显示 0）。
    let failed = '';
    try {
      await requestUsageSnapshot({ call: async () => { throw new Error('transport down'); } });
    } catch (error) { failed = String(error?.message ?? error); }
    check('传输失败时明确抛错（不静默当成 0 次）', failed.includes('transport down'), failed);

    // 隐私：快照里绝不能出现对话正文。
    const serialized = JSON.stringify(snapshot);
    check('快照不含 prompt/响应正文',
      !/"(messages|content|prompt|text)"/.test(serialized), 'unexpected payload field');
    check('快照不含凭据字段',
      !/"(apiKey|token|authorization|secret)"/i.test(serialized), 'unexpected credential field');
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
