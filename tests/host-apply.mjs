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
    ctx.on = (event, handler, opts) => {
      if (onThrows) throw new Error('on unsupported');
      subscriptions.push({ event, handler, opts });
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

    // 两条 route 都订阅：llm/stream（完整 usage）+ session/event（官方兜底路径）。
    // 真实宿主 context 上不需要 global —— 官方 antigravity 同样直接 ctx.on。
    check('订阅了 llm/stream 与 session/event',
      subscriptions.map(s => s.event).join(',') === 'llm/stream,session/event',
      subscriptions.map(s => s.event).join(','));
    check('订阅不带 global（真实 context 上不需要）',
      subscriptions.every(s => s.opts === undefined),
      JSON.stringify(subscriptions.map(s => s.opts)));
    // apply 的返回值是暴露给 client 的汇总入口。
    check('apply 返回带汇总接口的对象', typeof service?.summarize === 'function'
      && typeof service?.recent === 'function');
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
    check('缺少 ctx.provide 时不抛错且仍订阅', threw === null && noProvide.subscriptions.length === 2,
      `n=${noProvide.subscriptions.length}`);

    // storage 缺席：退回 home 目录仍能拿到路径（不抛错即可）
    threw = null;
    try { apply(makeCtx({}).ctx); } catch (e) { threw = e; }
    check('storage 缺席时退回默认目录', threw === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== 注册契约：与官方 host 插件同形 ==');
{
  const mod = await import('../index.js');
  // 官方能工作的 host 插件（dsh-tool-antigravity）就是这个形状：
  //   const name / const inject / export function apply(ctx, config)
  // 加载器把它当普通函数插件调用，apply 拿到的是**真实宿主 context**。
  check('导出 apply 函数', typeof mod.apply === 'function');
  check('导出 name 字符串', typeof mod.name === 'string' && mod.name.length > 0, mod.name);
  check('导出 inject 声明', mod.inject !== undefined, JSON.stringify(mod.inject));
  // inject 必须是普通数组：官方 antigravity 就是 `["llm", "attachments"]`。
  // 写成 { optional: [...] }（cordis Inject 装饰器写法）时加载器解析不了，
  // 给出的 ctx 是残的——服务全 get=undef、事件永不派发（实测确认）。
  check('inject 是普通数组（不是 optional 对象）', Array.isArray(mod.inject),
    JSON.stringify(mod.inject));
  // 回归守卫：曾误改成 Service 子类 / 工厂函数 / default class —— 那些形态下
  // 加载器给的 ctx 是残的（inject/effect undefined、服务全取不到）。
  check('不导出 default（避免加载器误取）', mod.default === undefined,
    typeof mod.default);
}

console.log('\n== apply 在真实 ctx 上订阅两条 route ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-shape-'));
  try {
    const regs = [];
    const ctx = {
      get: () => undefined,
      logger: { warn: () => {} },
      on: (ev, cb, opts) => { regs.push({ ev, cb, opts }); },
    };
    const mod = await import('../index.js');
    mod.apply(ctx);
    check('注册了 llm/stream 监听器', regs.some(r => r.ev === 'llm/stream'));
    check('注册了 session/event 监听器', regs.some(r => r.ev === 'session/event'));
    // 真实 context 上无需 global —— 官方 antigravity 也直接 ctx.on。
    check('订阅不带 global 选项', regs.every(r => r.opts === undefined),
      JSON.stringify(regs.map(r => r.opts)));
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
