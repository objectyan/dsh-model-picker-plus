// Host 侧账本测试：不依赖 DSH 运行时，直接验证 wrapStream / 归一化 / 聚合 / RPC 注册。
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __test, appendRecord, apply, buildUsageIndex, readLedger, registerUsageRpc, summarize, totalOf, wrapStream,
  RPC_NAMESPACE,
} from '../usage-host.js';

let failures = 0;
let capturedHandler = null;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function* fromChunks(chunks) {
  for (const c of chunks) {
    if (c instanceof Error) throw c;
    yield c;
  }
}

/** 跑一次 wrapStream 并收集：透传的 chunk + 落下的账。 */
async function run(options, chunks, nextImpl, clock) {
  const records = [];
  const seen = [];
  const next = nextImpl ?? (() => fromChunks(chunks));
  const iterable = wrapStream(options, next, (r) => records.push(r), clock);
  let threw = null;
  try {
    for await (const chunk of iterable) seen.push(chunk);
  } catch (error) {
    threw = error;
  }
  return { records, seen, threw };
}

console.log('== usage 归一化 ==');
{
  const { normalizeUsage } = __test;
  check('保留全部 token 字段',
    JSON.stringify(normalizeUsage({
      inputTokens: 10, outputTokens: 3, cacheReadTokens: 100,
      cacheWriteTokens: 5, reasoningTokens: 2, totalTokens: 113,
    })) === JSON.stringify({
      inputTokens: 10, outputTokens: 3, totalTokens: 113,
      cacheReadTokens: 100, cacheWriteTokens: 5, reasoningTokens: 2,
    }));
  check('缺项不写键（不编造 0）', (() => {
    const u = normalizeUsage({ inputTokens: 7 });
    return u.inputTokens === 7 && !('outputTokens' in u) && !('cacheReadTokens' in u);
  })());
  check('丢弃空对象与非对象',
    normalizeUsage({}) === null && normalizeUsage(null) === null && normalizeUsage('x') === null);
  check('拒绝 NaN/Infinity', normalizeUsage({ inputTokens: NaN, outputTokens: Infinity }) === null);
}

console.log('\n== finish 归一化 ==');
{
  const { normalizeFinish } = __test;
  check('stop 记为成功', normalizeFinish({ kind: 'stop' }).ok === true);
  check('tool-calls 记为成功', normalizeFinish({ kind: 'tool-calls' }).ok === true);
  check('error 记失败且只保留 code/status（不带原始 message）', (() => {
    const f = normalizeFinish({ kind: 'error', failure: { message: 'secret prompt leaked', code: 'E_X', status: 500 } });
    return f.ok === false && f.error.code === 'E_X' && f.error.status === 500
      && JSON.stringify(f).includes('secret') === false;
  })());
  check('aborted 记为失败', normalizeFinish({ kind: 'aborted', failure: { code: 'E_A' } }).ok === false);
  check('max-tokens 不算失败但标记截断', (() => {
    const f = normalizeFinish({ kind: 'max-tokens' });
    return f.ok === false && f.truncated === true;
  })());
  check('未知 reason 不崩', normalizeFinish(undefined).finishKind === 'unknown');
}

console.log('\n== wrapStream：透传与记账 ==');
{
  let mono = 0;
  const clock = { wall: () => 1_000, mono: () => mono };
  const chunks = [
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const { records, seen, threw } = await run(
    { provider: 'p', model: 'm', sessionId: 's1' },
    chunks,
    () => (async function* () { for (const c of chunks) { mono += 5; yield c; } })(),
    clock,
  );
  check('chunk 被原样透传', seen.length === 3 && threw === null);
  check('落地一条明细', records.length === 1, `n=${records.length}`);
  const r = records[0];
  check('明细含归属字段', r.provider === 'p' && r.model === 'm' && r.sessionId === 's1');
  check('明细含 token 用量', r.inputTokens === 100 && r.outputTokens === 20 && r.cacheReadTokens === 900);
  check('明细含 requestId（逐请求唯一，不靠 token 指纹）',
    typeof r.requestId === 'string' && r.requestId.length > 0);
  check('明细含起止时间与耗时',
    Number.isFinite(r.startedAt) && r.durationMs >= 0 && r.source === 'llm/stream');
  check('明细含结束状态', r.finishKind === 'stop' && r.ok === true);
  check('明细记录 usage 是否上报', r.usageReported === true);
}

console.log('\n== wrapStream：边界情况 ==');
{
  const { records, threw } = await run({ provider: 'p', model: 'm' }, [new Error('stream broke')]);
  check('流抛错时异常继续向上抛', threw !== null && threw.message === 'stream broke');
  check('流抛错仍落一条失败账', records.length === 1 && records[0].ok === false && records[0].finishKind === 'threw',
    JSON.stringify(records[0].finishKind));

  const aborted = new Error('cancelled');
  aborted.code = undefined;
  const ac = await run({ provider: 'p', model: 'm', signal: { aborted: true } }, [aborted]);
  check('取消的调用记为 aborted', ac.records[0].finishKind === 'aborted' && ac.records[0].ok === false);

  const cut = await run({ provider: 'p', model: 'm' }, [{ type: 'text-delta', index: 0, text: 'partial' }]);
  check('无 finish 记为 incomplete 失败', cut.records[0].finishKind === 'incomplete' && cut.records[0].ok === false);

  const merged = await run({ provider: 'p', model: 'm' }, [
    { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 50 } },
    { type: 'usage', usage: { outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('多帧 usage 合并而非覆盖',
    merged.records[0].inputTokens === 10 && merged.records[0].cacheReadTokens === 50 && merged.records[0].outputTokens === 4);

  const noUsage = await run({ provider: 'p', model: 'm' }, [{ type: 'finish', reason: { kind: 'stop' } }]);
  check('无 usage 时不写入 token 字段且标记未上报',
    noUsage.records[0].inputTokens === undefined && noUsage.records[0].usageReported === false);

  const bare = await run({}, [{ type: 'finish', reason: { kind: 'stop' } }]);
  check('缺少 provider/model 仍能记账', bare.records.length === 1 && bare.records[0].provider === '');

  let nextCalls = 0;
  await run({ provider: 'p', model: 'm' }, null, () => { nextCalls += 1; return fromChunks([{ type: 'finish', reason: { kind: 'stop' } }]); });
  check('next() 只被调用一次', nextCalls === 1, `calls=${nextCalls}`);

  // 同一次调用在两条 route 上都可能被看到；用 requestId 去重，而不是 token 指纹。
  const same = [
    { provider: 'p', model: 'm', requestId: 'r1', inputTokens: 5, outputTokens: 1, ok: true },
    { provider: 'p', model: 'm', requestId: 'r1', inputTokens: 5, outputTokens: 1, ok: true },
  ];
  check('相同 requestId 只计一次', buildUsageIndex(same)['p/m'].calls === 1);
  // 关键回归：两次真实调用用量完全相同时，绝不能被误删。
  const distinct = [
    { provider: 'p', model: 'm', requestId: 'r1', inputTokens: 5, outputTokens: 1, ok: true },
    { provider: 'p', model: 'm', requestId: 'r2', inputTokens: 5, outputTokens: 1, ok: true },
  ];
  check('用量相同的两次真实调用不会被误删', buildUsageIndex(distinct)['p/m'].calls === 2);

  // 旧版账本（无 requestId）保留了 llm/stream + session/event 的成对记录，
  // 读取时按指纹折叠，避免历史数据把次数算成两倍。
  const legacyPair = [
    { provider: 'p', model: 'm', inputTokens: 5, outputTokens: 1, startedAt: 100, ok: true, finishKind: 'tool-calls' },
    { provider: 'p', model: 'm', inputTokens: 5, outputTokens: 1, startedAt: 100, ok: true, finishKind: 'unknown', source: 'session/event' },
  ];
  check('旧格式成对记录被折叠为一次', buildUsageIndex(legacyPair)['p/m'].calls === 1,
    `calls=${buildUsageIndex(legacyPair)['p/m'].calls}`);
  // 旧格式但确实不同的调用（token 或时间不同）仍分别计入。
  const legacyDistinct = [
    { provider: 'p', model: 'm', inputTokens: 5, outputTokens: 1, startedAt: 100, ok: true },
    { provider: 'p', model: 'm', inputTokens: 6, outputTokens: 1, startedAt: 200, ok: true },
  ];
  check('旧格式不同调用仍分别计入', buildUsageIndex(legacyDistinct)['p/m'].calls === 2);
}

console.log('\n== token 合计口径 ==');
{
  // reasoning 是 output 的子集，不能再加一遍。
  check('total 优先用上游上报值', totalOf({ totalTokens: 620, inputTokens: 100, outputTokens: 20 }).value === 620);
  check('reasoning 不重复计入', totalOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 99 }).value === 10);
  check('缺字段时标记非精确', totalOf({ inputTokens: 1 }).exact === false);
}

console.log('\n== 落盘与聚合 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-usage-'));
  try {
    appendRecord(dir, { provider: 'a', model: 'x', requestId: 'r1', ok: true, durationMs: 10, inputTokens: 5, outputTokens: 1, usageReported: true });
    appendRecord(dir, { provider: 'a', model: 'x', requestId: 'r2', ok: false, durationMs: 30, inputTokens: 7, usageReported: true });
    appendRecord(dir, { provider: 'b', model: 'y', requestId: 'r3', ok: true, durationMs: 20, cacheReadTokens: 100, usageReported: true });
    const rows = readLedger(dir);
    check('JSONL 逐行追加可读回', rows.length === 3 && rows[0].provider === 'a');

    const agg = summarize(rows);
    const ax = agg['a/x'];
    check('聚合按 provider/model 归并', Object.keys(agg).length === 2 && ax.calls === 2);
    check('聚合区分成功与失败次数', ax.okCalls === 1 && ax.failedCalls === 1);
    check('聚合累加耗时与 token',
      ax.durationMs === 40 && ax.inputTokens === 12 && ax.outputTokens === 1, JSON.stringify(ax));
    check('缺失字段不参与累加（不产生 NaN）',
      agg['b/y'].cacheReadTokens === 100 && agg['b/y'].inputTokens === undefined);
    check('统计缺 usage 的调用数', agg['b/y'].usageCalls === 1 && agg['b/y'].missingUsageCalls === 0);

    check('读取不存在的目录返回空数组', readLedger(join(dir, 'nope')).length === 0);
    check('appendRecord 对空目录返回 false 而不抛', appendRecord(null, { provider: 'x' }) === false);

    // 轮转：不删除历史，而是另存为归档文件并继续累加。
    const small = mkdtempSync(join(tmpdir(), 'mp-rot-'));
    try {
      appendRecord(small, { provider: 'a', model: 'x', requestId: 'r1', inputTokens: 1 });
      appendRecord(small, { provider: 'a', model: 'x', requestId: 'r2', inputTokens: 2 }, 1);
      const files = readdirSync(small);
      check('轮转保留历史归档', files.some(f => /^llm-usage\.\d+\..+\.jsonl$/.test(f)), files.join(','));
      check('轮转后历史仍可读回（不丢数据）', readLedger(small).length === 2,
        `n=${readLedger(small).length}`);
    } finally {
      rmSync(small, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== 损坏行容错 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-usage-bad-'));
  try {
    const { LEDGER_FILE } = __test;
    appendRecord(dir, { provider: 'a', model: 'x', requestId: 'r1', ok: true });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(dir, LEDGER_FILE), '{"provider":"broken"\n', 'utf8');
    appendRecord(dir, { provider: 'a', model: 'x', requestId: 'r2', ok: true });
    check('损坏行被跳过，好行照常读出', readLedger(dir).length === 2, `n=${readLedger(dir).length}`);
    check('尾部撕裂行不会吞掉后续写入', readLedger(dir).every(r => r.provider === 'a'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== RPC：注册与入参校验 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-rpc-'));
  try {
    appendRecord(dir, { provider: 'p', model: 'm', requestId: 'r1', sessionId: 's1', ok: true, inputTokens: 10, outputTokens: 2, usageReported: true });
    const calls = [];
    let handleChannel = null;
    const connection = {
      rpc: {
        handle(channel, handler) {
          handleChannel = channel;
          capturedHandler = handler;
          return () => {};
        },
        // /api 的 interceptor 已被其它插件占用：这里模拟真实宿主，
        // 一旦本插件去 intercept 就抛错，确保实现不会退回那条路。
        intercept() { throw new Error('connection: shared RPC channel "/api" already has an interceptor'); },
      },
    };
    const service = { snapshot: (query) => ({ schemaVersion: 2, models: buildUsageIndex(readLedger(dir)), recent: [], status: { query } }) };
    const ok = registerUsageRpc(connection, service);

    check('用命名通道 handle 注册（不占用共享 /api）', ok === true && handleChannel === RPC_NAMESPACE, String(handleChannel));
    check('/api 被占用也不影响本插件注册', ok === true);

    // 入参校验：越权/未知字段一律拒绝。
    const unknown = await capturedHandler('snapshot', { evil: 1 });
    check('拒绝未知查询字段', unknown.ok === false && unknown.error.code === 'BAD_REQUEST');
    const badLimit = await capturedHandler('snapshot', { limit: 99999 });
    check('拒绝越界 limit', badLimit.ok === false);
    const notFound = await capturedHandler('nope', {});
    check('未知端点返回 NOT_FOUND', notFound.ok === false && notFound.error.code === 'NOT_FOUND');
    const good = await capturedHandler('snapshot', { sessionId: 's1' });
    check('正常查询返回快照', good.ok === true && good.value.schemaVersion === 2);
    check('快照不含 prompt/响应正文', JSON.stringify(good.value).includes('messages') === false);

    // 老宿主只有 intercept 时的兜底路径仍要能工作。
    const legacyCalls = [];
    const legacy = { rpc: { intercept: (channel, matches, handler) => { legacyCalls.push({ channel, matches, handler }); return () => {}; } } };
    check('无 handle 时退回 intercept 兜底', registerUsageRpc(legacy, service) === true
      && legacyCalls[0]?.channel === '/api');
    check('兜底只匹配自己的命名空间',
      legacyCalls[0].matches(`${RPC_NAMESPACE}/snapshot`) === true
      && legacyCalls[0].matches('other/snapshot') === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== apply：订阅与降级 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-apply-'));
  try {
    const subs = [];
    const ctx = {
      logger: { warn: () => {} },
      on: (event, handler) => { subs.push({ event, handler }); },
    };
    const service = apply(ctx, { dataDir: dir });
    check('订阅 llm/stream（不订阅 session/event，避免重复计数）',
      subs.map(s => s.event).join(',') === 'llm/stream', subs.map(s => s.event).join(','));
    check('返回带 snapshot/summarize 的服务', typeof service.snapshot === 'function'
      && typeof service.summarize === 'function');

    // 驱动一次真实记账。
    const iterable = subs[0].handler(
      { provider: 'prov', model: 'mod', sessionId: 'sess-1' },
      () => fromChunks([
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]),
    );
    for await (const _ of iterable) { /* 驱动完 */ }
    const snap = service.snapshot({});
    check('快照含真实记录', snap.models['prov/mod']?.calls === 1, JSON.stringify(snap.models['prov/mod']));
    check('快照带采集状态（可判定是否已开始采集）',
      snap.status?.collecting === true && snap.status.persistedCalls === 1, JSON.stringify(snap.status));

    // 无 ctx.on：不应抛错。
    let threw = null;
    try { apply({ logger: { warn: () => {} } }, { dataDir: dir }); } catch (e) { threw = e; }
    check('缺少 ctx.on 时不抛错', threw === null, String(threw));

    // 回归守卫：connection 未就绪时插件必须照常挂载。
    // 曾把 connection 写进 inject 数组（= 硬依赖），启动早期它就绪不了，
    // 结果整个插件挂不上——实测表现正是「插件重启后无法启动」。
    const mod = await import('../usage-host.js');
    check('inject 不含 connection（它只用于回传，不能作硬依赖）',
      !mod.inject.includes('connection'), JSON.stringify(mod.inject));
    let noConnThrew = null;
    const noConnSubs = [];
    try {
      apply({
        logger: { warn: () => {} },
        get: () => undefined,
        on: (event) => { noConnSubs.push(event); },
      }, { dataDir: dir });
    } catch (e) { noConnThrew = e; }
    check('connection 未就绪时仍能挂载并订阅 llm/stream',
      noConnThrew === null && noConnSubs.includes('llm/stream'),
      String(noConnThrew ?? noConnSubs.join(',')));

    // 账本目录不可写也不能抛：采集是旁路功能，不能拖垮插件加载。
    let badDirThrew = null;
    try { apply({ logger: { warn: () => {} }, on: () => {} }, { dataDir: '\u0000invalid' }); } catch (e) { badDirThrew = e; }
    check('账本目录不可写时不抛错', badDirThrew === null, String(badDirThrew));
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
