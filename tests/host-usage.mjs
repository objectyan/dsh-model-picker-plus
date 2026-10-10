// Host 侧账本测试：不依赖 DSH 运行时，直接验证 wrapStream / 归一化 / 聚合。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test, readLedger, summarize, wrapStream } from '../index.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** 造一个可控的 chunk 流。 */
async function* fromChunks(chunks) {
  for (const c of chunks) {
    if (c instanceof Error) throw c;
    yield c;
  }
}

/** 跑一次 wrapStream 并收集：透传的 chunk + 落下的账。 */
async function run(options, chunks, nextImpl) {
  const records = [];
  const seen = [];
  const next = nextImpl ?? (() => fromChunks(chunks));
  const iterable = wrapStream(options, next, (r) => records.push(r));
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
  check('normalizeUsage 保留全部 token 字段',
    JSON.stringify(normalizeUsage({
      inputTokens: 10, outputTokens: 3, cacheReadTokens: 100,
      cacheWriteTokens: 5, reasoningTokens: 2, totalTokens: 113,
    })) === JSON.stringify({
      inputTokens: 10, outputTokens: 3, totalTokens: 113,
      cacheReadTokens: 100, cacheWriteTokens: 5, reasoningTokens: 2,
    }));
  check('normalizeUsage 缺项用 undefined 而不是编造 0', (() => {
    const u = normalizeUsage({ inputTokens: 7 });
    return u.inputTokens === 7 && u.outputTokens === undefined && u.cacheReadTokens === undefined;
  })());
  check('normalizeUsage 丢弃空对象与非对象',
    normalizeUsage({}) === null && normalizeUsage(null) === null && normalizeUsage('x') === null);
  check('normalizeUsage 拒绝 NaN/Infinity', normalizeUsage({ inputTokens: NaN, outputTokens: Infinity }) === null);
}

console.log('\n== finish 归一化 ==');
{
  const { normalizeFinish } = __test;
  check('stop 记为成功', normalizeFinish({ kind: 'stop' }).ok === true);
  check('tool-calls 记为成功', normalizeFinish({ kind: 'tool-calls' }).ok === true);
  check('error 记为失败并带 failure', (() => {
    const f = normalizeFinish({ kind: 'error', failure: { message: 'boom', code: 'E_X', status: 500 } });
    return f.ok === false && f.error.message === 'boom' && f.error.code === 'E_X' && f.error.status === 500;
  })());
  check('aborted 记为失败', normalizeFinish({ kind: 'aborted', failure: { message: 'cancel', code: 'E_A' } }).ok === false);
  check('max-tokens 不算失败但标记截断', (() => {
    const f = normalizeFinish({ kind: 'max-tokens' });
    return f.ok === false && f.truncated === true && f.error === undefined;
  })());
  check('未知/缺失 reason 不崩', normalizeFinish(undefined).finishKind === 'unknown' && normalizeFinish(null).ok === false);
}

console.log('\n== wrapStream：透传与记账 ==');
{
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hi' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const { records, seen, threw } = await run({ provider: 'p', model: 'm', sessionId: 's1' }, chunks);
  check('chunk 被原样透传', seen.length === 4 && seen[3].type === 'finish' && threw === null);
  check('落地一条明细', records.length === 1, `n=${records.length}`);
  const r = records[0];
  check('明细含归属字段', r.provider === 'p' && r.model === 'm' && r.sessionId === 's1');
  check('明细含 token 用量', r.inputTokens === 100 && r.outputTokens === 20 && r.cacheReadTokens === 900);
  check('明细含起止时间与耗时',
    Number.isFinite(r.startedAt) && Number.isFinite(r.endedAt) && r.durationMs >= 0 && r.endedAt >= r.startedAt);
  check('明细含结束状态', r.finishKind === 'stop' && r.ok === true);
}

console.log('\n== wrapStream：边界情况 ==');
{
  // 失败调用也必须记账，否则失败的请求会凭空消失。
  const { records, threw } = await run({ provider: 'p', model: 'm' }, [new Error('stream broke')]);
  check('流抛错时异常继续向上抛', threw !== null && threw.message === 'stream broke');
  check('流抛错仍落一条失败账', records.length === 1 && records[0].ok === false && records[0].finishKind === 'threw',
    JSON.stringify(records[0]));

  // 没有 finish（流被提前切断）
  const cut = await run({ provider: 'p', model: 'm' }, [{ type: 'text-delta', index: 0, text: 'partial' }]);
  check('无 finish 记为 incomplete 失败', cut.records[0].finishKind === 'incomplete' && cut.records[0].ok === false);

  // 多帧 usage 应合并，且不因后帧缺字段而丢前面的值
  const merged = await run({ provider: 'p', model: 'm' }, [
    { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 50 } },
    { type: 'usage', usage: { outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  check('多帧 usage 合并而非覆盖',
    merged.records[0].inputTokens === 10 && merged.records[0].cacheReadTokens === 50 && merged.records[0].outputTokens === 4,
    JSON.stringify(merged.records[0]));

  // 无 usage 的调用：不能编造 0
  const noUsage = await run({ provider: 'p', model: 'm' }, [{ type: 'finish', reason: { kind: 'stop' } }]);
  check('无 usage 时不写入 token 字段',
    noUsage.records[0].inputTokens === undefined && noUsage.records[0].outputTokens === undefined);

  // 缺少 provider/model 也不能崩
  const bare = await run({}, [{ type: 'finish', reason: { kind: 'stop' } }]);
  check('缺少 provider/model 仍能记账', bare.records.length === 1 && bare.records[0].provider === '');

  // next() 只调用一次
  let nextCalls = 0;
  await run({ provider: 'p', model: 'm' }, null, () => { nextCalls += 1; return fromChunks([{ type: 'finish', reason: { kind: 'stop' } }]); });
  check('next() 只被调用一次', nextCalls === 1, `calls=${nextCalls}`);
}

console.log('\n== 落盘与聚合 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-usage-'));
  try {
    const { appendRecord } = __test;
    appendRecord(dir, { provider: 'a', model: 'x', ok: true, durationMs: 10, inputTokens: 5, outputTokens: 1 });
    appendRecord(dir, { provider: 'a', model: 'x', ok: false, durationMs: 30, inputTokens: 7 });
    appendRecord(dir, { provider: 'b', model: 'y', ok: true, durationMs: 20, cacheReadTokens: 100 });
    const rows = readLedger(dir);
    check('JSONL 逐行追加可读回', rows.length === 3 && rows[0].provider === 'a' && rows[2].cacheReadTokens === 100);

    const agg = summarize(rows);
    const ax = agg['a/x'];
    check('聚合按 provider/model 归并', Object.keys(agg).length === 2 && ax.calls === 2, Object.keys(agg).join(','));
    check('聚合区分成功与失败次数', ax.okCalls === 1 && ax.failedCalls === 1);
    check('聚合累加耗时与 token',
      ax.durationMs === 40 && ax.inputTokens === 12 && ax.outputTokens === 1,
      JSON.stringify(ax));
    // 缺失字段必须保持 undefined（未参与累加），而不是被算成 NaN 或 0。
    check('缺失字段不参与累加（不产生 NaN）',
      agg['b/y'].cacheReadTokens === 100
      && agg['b/y'].inputTokens === undefined
      && agg['a/x'].cacheReadTokens === undefined
      && !Number.isNaN(agg['b/y'].cacheReadTokens),
      JSON.stringify(agg['b/y']));

    check('读取不存在的目录返回空数组', readLedger(join(dir, 'nope')).length === 0);
    check('appendRecord 对空目录返回 false 而不抛', appendRecord(null, { provider: 'x' }) === false);

    // buildUsageIndex：client 侧直接消费的索引
    const { buildUsageIndex } = __test;
    const index = buildUsageIndex([
      { provider: 'a', model: 'x', ok: true, durationMs: 10, inputTokens: 5, outputTokens: 1, sessionId: 's1', startedAt: 100, endedAt: 110 },
      { provider: 'a', model: 'x', ok: false, durationMs: 30, inputTokens: 7, sessionId: 's1', startedAt: 200, endedAt: 230 },
      { provider: 'a', model: 'x', ok: true, durationMs: 5, sessionId: 's2', startedAt: 300, endedAt: 305 },
    ]);
    const ax2 = index['a/x'];
    check('索引按 provider/model 归并', Object.keys(index).length === 1 && ax2.calls === 3);
    check('索引区分成功/失败', ax2.okCalls === 2 && ax2.failedCalls === 1);
    check('索引累计 tokens（各 token 之和）', ax2.tokens === 13 && ax2.inputTokens === 12 && ax2.outputTokens === 1);
    check('索引记录会话分布', ax2.sessions.s1 === 2 && ax2.sessions.s2 === 1);
    check('索引记录首末时间', ax2.firstAt === 100 && ax2.lastAt === 305);
    check('空输入返回空索引', JSON.stringify(buildUsageIndex([])) === '{}' && JSON.stringify(buildUsageIndex(null)) === '{}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== 损坏行容错 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-usage-bad-'));
  try {
    const { appendRecord, LEDGER_FILE } = __test;
    appendRecord(dir, { provider: 'a', model: 'x', ok: true });
    // 手工塞一行坏数据（模拟断电写了一半）
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(dir, LEDGER_FILE), '{"provider":"broken"\n', 'utf8');
    appendRecord(dir, { provider: 'a', model: 'x', ok: true });
    const rows = readLedger(dir);
    check('损坏行被跳过，好行照常读出', rows.length === 2, `n=${rows.length}`);
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
