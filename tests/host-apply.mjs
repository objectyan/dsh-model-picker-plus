// host 端 apply() 冒烟测试：用假 ctx 驱动，确认订阅、聚合暴露与降级路径都不崩。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, readLedger, __test } from '../index.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** 造一个最小 ctx：记录订阅与 provide。 */
function makeCtx({ dataDir, withOn = true, withProvide = true, onThrows = false } = {}) {
  const subscriptions = [];
  const provided = {};
  const ctx = {
    get: (key) => (key === 'storage' && dataDir ? { dataDir } : undefined),
    logger: { warn: () => {} },
  };
  if (withOn) {
    ctx.on = (event, handler) => {
      if (onThrows) throw new Error('on unsupported');
      subscriptions.push({ event, handler });
    };
  }
  if (withProvide) {
    ctx.provide = (key, value) => { provided[key] = value; };
  }
  return { ctx, subscriptions, provided };
}

console.log('== apply：正常路径 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-apply-'));
  try {
    const { ctx, subscriptions } = makeCtx({ dataDir: dir });
    const service = apply(ctx);

    check('订阅了 llm/stream', subscriptions.length === 1 && subscriptions[0].event === 'llm/stream',
      subscriptions.map(s => s.event).join(','));
    // 服务实例是暴露给 client 的唯一入口（取代旧的 ctx.provide）。
    check('apply 返回带汇总接口的服务实例', typeof service?.summarize === 'function'
      && typeof service?.recent === 'function');
    check('服务实例挂到 ctx 供 client 取件', ctx.modelPickerUsage === service);
    check('暴露的账本路径可定位', typeof service.ledgerPath === 'string' && service.ledgerPath.endsWith('llm-usage.jsonl'),
      service.ledgerPath);

    // 驱动一次订阅：确认真的落到盘上
    const handler = subscriptions[0].handler;
    const chunks = [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const iterable = handler(
      { provider: 'prov', model: 'mod', sessionId: 'sess-1' },
      () => (async function* () { for (const c of chunks) yield c; })(),
    );
    const seen = [];
    for await (const chunk of iterable) seen.push(chunk);

    check('handler 透传全部 chunk', seen.length === 2);
    // resolveDataDir 会在传入的 dataDir 下再建一个插件专属子目录。
    const ledgerDir = join(dir, 'dsh-model-picker-plus');
    const rows = readLedger(ledgerDir);
    check('调用后账本落了一条明细', rows.length === 1, `n=${rows.length}`);
    check('明细字段完整', rows[0].provider === 'prov' && rows[0].model === 'mod'
      && rows[0].sessionId === 'sess-1' && rows[0].inputTokens === 10 && rows[0].ok === true);

    // 汇总接口能读到刚写的这条
    const index = service.summarize();
    check('汇总接口反映写入结果', index['prov/mod']?.calls === 1 && index['prov/mod']?.tokens === 12,
      JSON.stringify(index));
    check('recent 返回明细', service.recent(10).length === 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== apply：缺能力时静默降级 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-apply-deg-'));
  try {
    // 没有 ctx.on：不应抛错，也不能崩
    let threw = null;
    try { apply(makeCtx({ dataDir: dir, withOn: false }).ctx); } catch (e) { threw = e; }
    check('缺少 ctx.on 时不抛错', threw === null, String(threw));

    // ctx.on 抛错：订阅失败也不该影响插件其他部分
    threw = null;
    try { apply(makeCtx({ dataDir: dir, onThrows: true }).ctx); } catch (e) { threw = e; }
    check('ctx.on 抛错时被吞掉', threw === null, String(threw));

    // 没有 ctx.provide：记账照常，只是不暴露接口
    const noProvide = makeCtx({ dataDir: dir, withProvide: false });
    threw = null;
    try { apply(noProvide.ctx); } catch (e) { threw = e; }
    check('缺少 ctx.provide 时不抛错且仍订阅', threw === null && noProvide.subscriptions.length === 1);

    // storage 缺席：退回 home 目录仍能拿到路径（不抛错即可）
    threw = null;
    try { apply(makeCtx({}).ctx); } catch (e) { threw = e; }
    check('storage 缺席时退回默认目录', threw === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== 记账失败不影响调用结果 ==');
{
  // 账本目录不可写时，调用结果必须照常返回。
  const { wrapStream } = __test;
  const records = [];
  const iterable = wrapStream(
    { provider: 'p', model: 'm' },
    () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })(),
    () => { throw new Error('ledger write exploded'); },
  );
  let seen = 0;
  let threw = null;
  try { for await (const _ of iterable) seen += 1; } catch (e) { threw = e; }
  check('回调抛错不阻断 chunk 透传', seen === 1 && threw === null, `seen=${seen}`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
