// dsh-model-picker-plus —— Host 侧：逐请求 LLM 使用账本
//
// 为什么统计必须放在 host 侧：
//   client（platform: web）订阅不到宿主的 `llm/stream` 事件，也就拿不到
//   provider/model/sessionId 与上游报告的精确 token。契约见 DSH 的
//   `llm/stream` waterfall —— 它在**每次**流式调用外层包裹一次（含重试、
//   重放、路由），options 带 provider/model/sessionId/purpose，
//   返回的 chunk 流里有 `usage` 与 `finish`（结束原因）。
//
// 记录口径（逐请求，一条明细）：
//   provider, model, sessionId?, purpose?, startedAt, endedAt, durationMs,
//   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
//   reasoningTokens, totalTokens?, finishKind, ok, error?
//
// 落盘：JSONL 追加（每行一条），写到插件自己的数据目录下。
//   追加写的好处：崩溃/断电最多丢最后一行，不会像"整体重写 JSON"那样
//   把已积累的历史一起写坏。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 依赖声明：storage 用来挑数据目录（可选，缺失时退回 ~/.dsh）；
// llm 只在诊断时读取，不订阅（记账靠 ctx.on('llm/stream')，与 llm 服务无
// 生命周期耦合，所以不必 inject——少一个硬依赖就少一个挂载失败的理由）。
const LEDGER_FILE = 'llm-usage.jsonl';
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 超过就轮转一份 .1，避免无限增长

// 加载探针：模块被 import 的那一刻就写一个文件。
//
// 为什么需要它：「目录存在但一条账都没有」有两种完全不同的原因——
//   a) 模块根本没被加载（服务注册形态不对 / bundle 没挂上）；
//   b) 模块加载了，但 llm/stream 没触发（或触发时记账失败）。
// 光看目录分不出来，这个探针把两种情况一刀切开。
// 成功挂载并记到第一笔账后会自行删除，不留长期痕迹。
try {
  const probeDir = join(homedir(), '.dsh', 'dsh-model-picker-plus');
  mkdirSync(probeDir, { recursive: true });
  appendFileSync(join(probeDir, 'loaded.marker'), `${new Date().toISOString()}\n`, 'utf8');
} catch { /* 探针失败绝不影响服务本身 */ }

/** 解析账本目录：优先 DSH 数据目录，退回 ~/.dsh。 */
function resolveDataDir(ctx) {
  const candidates = [];
  try {
    const storage = typeof ctx?.get === 'function' ? ctx.get('storage') : undefined;
    const dir = storage?.dataDir ?? storage?.directory ?? storage?.root;
    if (typeof dir === 'string' && dir) candidates.push(join(dir, 'dsh-model-picker-plus'));
  } catch { /* storage 不可用就走后面的候选 */ }
  try {
    if (process.env.DSH_DATA_DIR) candidates.push(join(process.env.DSH_DATA_DIR, 'dsh-model-picker-plus'));
  } catch { /* env 读不到忽略 */ }
  try {
    candidates.push(join(homedir(), '.dsh', 'dsh-model-picker-plus'));
  } catch { /* homedir 异常时退到当前目录 */ }
  candidates.push(join(process.cwd(), '.dsh-model-picker-plus'));

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** usage chunk → 统一字段；缺项直接**不带这个键**（而不是带 undefined）。 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const out = {};
  // 只有真的拿到数值才写键：多帧 usage 合并时，后帧的 undefined 不能
  // 覆盖前帧已有的值（曾经因为显式 undefined 键导致越合并越少）。
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = num(usage[field]);
    if (value !== undefined) out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 从一段 chunk 流里取**最后一个** usage（官方 token-meter 的取法）。
 * 兼容数组与异步迭代器两种形态：会话事件里的 stream 通常已物化。
 */
function lastUsageChunk(stream) {
  if (!stream || typeof stream !== 'object') return null;
  const list = Array.isArray(stream) ? stream : (Array.isArray(stream.chunks) ? stream.chunks : null);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const chunk = list[i];
    if (chunk && chunk.type === 'usage' && chunk.usage) return chunk.usage;
  }
  return null;
}

/** finish chunk 的 reason → 精简状态。 */
function normalizeFinish(reason) {
  const kind = reason && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : 'unknown';
  const failure = reason && typeof reason === 'object' ? reason.failure : undefined;
  return {
    finishKind: kind,
    ok: kind === 'stop' || kind === 'tool-calls',
    // 'max-tokens' 属于「跑完了但被截断」，既不算失败也不算完整成功。
    truncated: kind === 'max-tokens',
    error: failure && typeof failure === 'object'
      ? { message: String(failure.message ?? ''), code: String(failure.code ?? ''), status: failure.status }
      : undefined,
  };
}

/** 追加一行（同步、容错；失败只警告，绝不影响模型调用）。 */
function appendRecord(dir, record) {
  if (!dir) return false;
  const file = join(dir, LEDGER_FILE);
  try {
    if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch { /* 轮转失败就继续写原文件 */ }
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    // 记到第一笔账即说明「加载 + 订阅 + 落盘」整条链路都通，探针可以撤了。
    try { unlinkSync(join(dir, 'loaded.marker')); } catch { /* 没有探针就算了 */ }
    return true;
  } catch (error) {
    try { ctxWarn(`写入使用账本失败：${error?.message ?? error}`); } catch { /* 忽略 */ }
    return false;
  }
}

let warnFn = null;
const ctxWarn = (msg) => { if (warnFn) warnFn(msg); };

/**
 * 包一层 llm/stream：透传所有 chunk，只在结束时落一条账。
 * 关键点：
 *   · `next()` 只调用一次 —— waterfall 的语义是「调用它拿到下游流」；
 *   · 首次调用 next() 的时机就是请求真正发出的时刻，用它做 startedAt；
 *   · try/finally 保证异常路径也记账（否则失败调用会凭空消失）；
 *   · 全程不修改 options（契约明确：LOOP 构造的请求是深冻结的，改写会抛）。
 */
export function wrapStream(options, next, onRecord) {
  const provider = String(options?.provider ?? '');
  const model = String(options?.model ?? '');
  const sessionId = options?.sessionId === undefined ? undefined : String(options.sessionId);
  const purpose = options?.purpose;

  let usage = null;
  let finish = null;
  let startedAt = null;
  let streamError = null;

  return (async function* wrapped() {
    try {
      const inner = next();
      startedAt = Date.now();
      for await (const chunk of inner) {
        if (chunk && chunk.type === 'usage') {
          // usage 可能分多帧到达（例如增量上报），后到的覆盖先到的；
          // 若后续帧字段更少，保留已有值，避免越报越少。
          const next_ = normalizeUsage(chunk.usage);
          if (next_) usage = { ...(usage ?? {}), ...next_ };
        } else if (chunk && chunk.type === 'finish') {
          finish = normalizeFinish(chunk.reason);
        }
        yield chunk; // 原样透传，绝不干扰主流程
      }
    } catch (error) {
      streamError = error;
      throw error;
    } finally {
      const endedAt = Date.now();
      const state = finish ?? (streamError
        ? { finishKind: 'threw', ok: false, truncated: false, error: { message: String(streamError?.message ?? streamError), code: String(streamError?.code ?? '') } }
        : { finishKind: 'incomplete', ok: false, truncated: false });
      try {
        onRecord({
          provider,
          model,
          sessionId,
          purpose,
          startedAt: startedAt ?? endedAt,
          endedAt,
          durationMs: endedAt - (startedAt ?? endedAt),
          ...(usage ?? {}),
          finishKind: state.finishKind,
          ok: state.ok === true,
          ...(state.truncated ? { truncated: true } : {}),
          ...(state.error ? { error: state.error } : {}),
        });
      } catch { /* 记账失败绝不能影响调用结果 */ }
    }
  })();
}

/**
 * 把明细聚合为 client 直接可用的索引：
 *   { "provider/model": { calls, okCalls, failedCalls, tokens, durationMs,
 *                         inputTokens?, outputTokens?, cacheReadTokens?, ... } }
 * `tokens` 是各 token 字段之和，便于「按 token 量排序」直接取用。
 */
export function buildUsageIndex(records) {
  const out = {};
  for (const r of Array.isArray(records) ? records : []) {
    const key = `${r?.provider ?? ''}/${r?.model ?? ''}`;
    const acc = out[key] ?? {
      key, provider: r?.provider ?? '', model: r?.model ?? '',
      calls: 0, okCalls: 0, failedCalls: 0, durationMs: 0, tokens: 0,
    };
    acc.calls += 1;
    if (r?.ok === true) acc.okCalls += 1; else acc.failedCalls += 1;
    if (Number.isFinite(r?.durationMs)) acc.durationMs += r.durationMs;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      if (Number.isFinite(r?.[field])) {
        acc[field] = (acc[field] ?? 0) + r[field];
        acc.tokens += r[field];
      }
    }
    // 会话列表：便于后期按会话统计。
    if (typeof r?.sessionId === 'string' && r.sessionId) {
      acc.sessions = acc.sessions ?? {};
      acc.sessions[r.sessionId] = (acc.sessions[r.sessionId] ?? 0) + 1;
    }
    if (Number.isFinite(r?.startedAt)) {
      acc.firstAt = acc.firstAt === undefined ? r.startedAt : Math.min(acc.firstAt, r.startedAt);
      acc.lastAt = acc.lastAt === undefined ? r.endedAt ?? r.startedAt : Math.max(acc.lastAt, r.endedAt ?? r.startedAt);
    }
    out[key] = acc;
  }
  return out;
}

/**
 * Host 侧服务：订阅 llm/stream，把每次模型调用落成一条 JSONL 明细。
 *
 * 为什么用工厂（而不是直接 `class X extends Service`）：DSH 的插件加载器
 * （cordis）要求服务是带**静态 inject 元数据**的 Service 子类。但 cordis 的
 * `Service` 只在宿主运行时可解析，本包的单元测试是裸 node 跑的——顶层硬
 * import 会让全部测试 ERR_MODULE_NOT_FOUND，包括与本文件无关的用例。
 * 工厂形式把基类解析推迟到运行时：宿主上继承真 Service，测试环境退化为
 * ��通类，服务逻辑完全一致。
 *
 * 附注（两次踩坑，都记在这里免得再犯）：
 *   1. 早期版本用 `export const inject = {...}` + `export function apply()`，
 *      加载器不认，host 侧从未真正挂载——症状是账本目录被创建却一条账都没有。
 *   2. 改用工厂后症状**没变**：cordis-loader 会做
 *      `exports = exports.default ?? exports`，然后把结果当**服务类**实例化。
 *      default 导出工厂函数时，加载器拿到的是函数不是类，服务照样建不起来。
 *      —— 探针 loaded.marker 存在但无账本，正是这个症状。
 *      所以 default 必须导出**类本身**，不能是造类的工厂。
 * 官方 dsh-token-meter 直接 `export default class extends Service`，
 * 是同一套约定。
 */
/** cordis 在 `new` 之后读取这个 Symbol 数组来跑初始化钩子。 */
const INIT_HOOKS = Symbol.for('cordis.initHooks');

/**
 * Host 侧服务：订阅 llm/stream，把每次模型调用落成一条 JSONL 明细。
 *
 * 注册形态（三次踩坑后的定论，见文件头）：
 *   · `default` 导出**类本身** —— 加载器做 `exports.default ?? exports` 后
 *     直接 `new callback(ctx, config)`，导出工厂函数会拿到函数而非类；
 *   · 挂订阅用 cordis 的 **initHooks**（`Symbol.for('cordis.initHooks')`），
 *     而不是构造函数。cordis 在 `new` 之后才跑 hooks，那时 fiber 已就绪；
 *     官方 token-meter 能在构造函数里直接 `ctx.on`，是因为它继承的是真
 *     `Service`（能 `super(ctx, name)` 自我注册）。
 *
 * 为什么不继承 cordis Service：`@deepseek-ai/cordis` 只存在于 app.asar 内部，
 * 不在 profile 的 node_modules（实测 createRequire 也解析不到），所以插件里
 * 拿不到真基类——早先几版因此静默退化，类能 new 但订阅挂不上。
 * initHooks 不需要基类，只依赖一个全局 Symbol，是这里唯一可靠的挂载点。
 */
export class ModelPickerUsage {
  // storage 用来挑数据目录；缺失也能工作（退回 ~/.dsh），所以走 optional。
  static inject = { optional: ['storage'] };

  constructor(ctx, _config = {}) {
    this.ctx = ctx;
    this.ledgerDir = resolveDataDir(ctx);
    this.ledgerPath = this.ledgerDir ? join(this.ledgerDir, LEDGER_FILE) : null;
    try { warnFn = typeof ctx?.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : null; } catch { warnFn = null; }

    // 诊断：构造函数是否真的被调用过。这是整条链路的分水岭——
    // 没有这一行就分不清「插件没加载」与「加载了但订阅没挂上」。
    try {
      mkdirSync(this.ledgerDir, { recursive: true });
      appendFileSync(join(this.ledgerDir, 'attach.log'), `CTOR ${new Date().toISOString()}\n`, 'utf8');
    } catch { /* 诊断写不了就算了 */ }

    // 在 cordis 的 init 阶段挂订阅（而不是构造函数里）：那时 fiber 已就绪，
    // ctx.on 才真正注册到活着的上下文上。
    const hooks = (this[INIT_HOOKS] ??= []);
    hooks.push(() => this._attach());
    // 兜底：若某个 cordis 版本不跑 initHooks（例如我们直接被 new 出来），
    // 构造末尾立即挂一次。重复订阅由 _attached 标志挡住。
    this._attach();
  }

  _attach() {
    if (this._attached) return;
    const ctx = this.ctx;
    const note = (line) => {
      try {
        const dir = this.ledgerDir ?? join(homedir(), '.dsh', 'dsh-model-picker-plus');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'attach.log'), `${line}\n`, 'utf8');
      } catch { /* 诊断写不了就算了 */ }
    };
    note(`ctor ${new Date().toISOString()} ctx=${ctx ? 'yes' : 'no'} on=${typeof ctx?.on}`);
    if (!ctx || typeof ctx.on !== 'function') {
      note('SKIP: ctx.on unavailable');
      return;
    }
    try {
      // 两条订阅都挂，因为两条 route 的作用域语义不同：
      //
      // 1) llm/stream —— 每次模型调用的 waterfall，带 options.provider/model
      //    和最完整的 usage。它是 `ctx.waterfall(this, 'llm/stream', ...)`
      //    触发的，receiver 是 LlmRuntime 实例。
      // 2) session/event —— 会话事件流（官方 token-meter 走这条）。
      //    receiver 是 scopeTarget(session, ...) 生成的 carrier，其
      //    [Context.filter] 会沿 scope 链筛选：插件 fiber 不在链上就收不到。
      //
      // 共同点：都必须 `global: true`。cordis 的 dispatch 是
      //   hooks.filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
      // —— global 的检查在 filter **之前**，所以只有它能跨作用域。
      // 实测：不加 global 时 attach.log 停在 "OK: subscribed" 且永无 EVT。
      ctx.on('llm/stream', (options, next) => {
        note(`EVT-llm ${new Date().toISOString()} provider=${options?.provider} model=${options?.model}`);
        return wrapStream(options, next, (record) => {
          appendRecord(this.ledgerDir, record);
        });
      }, { global: true });
      note('OK: subscribed llm/stream (global)');

      // 落盘兜底：llm/stream 若因宿主版本差异收不到，这里仍能从会话事件
      // 里把 usage 捞出来（官方 token-meter 就是这么读的，因而更稳）。
      ctx.on('session/event', (session, event) => {
        try {
          this._observeSessionEvent(session, event);
        } catch { /* 观测失败绝不影响会话 */ }
      }, { global: true });
      note('OK: subscribed session/event (global)');

      this._attached = true;
    } catch (error) {
      note(`FAIL: ${error?.message ?? error}`);
      ctxWarn(`订阅 llm/stream 失败：${error?.message ?? error}`);
    }
  }

  /**
   * 从会话事件里捞一次调用的 usage。
   *
   * 官方 token-meter 的取法（usage-projection.js）：
   *   - `assistant/message` 且 data.usage 存在 → 直接用它；
   *   - 否则看 data.stream 里**最后一个 usage chunk**。
   * provider/model 来自 assistant 消息自身的 source（messageRoute）。
   * 这样即使 llm/stream 收不到，账本依然能记上。
   */
  _observeSessionEvent(session, event) {
    const type = event?.type;
    const data = event?.data;
    if (type !== 'assistant/message' && type !== 'assistant/attempt') return;

    const usage = data?.usage ?? lastUsageChunk(data?.stream);
    if (!usage) return;

    const route = data?.message?.source ?? data?.source ?? {};
    const provider = String(route.provider ?? '');
    const model = String(route.model ?? '');
    if (provider === '' && model === '') return; // 没归属信息就不记，避免脏数据

    const sessionId = session?.id ?? session?.sessionId ?? session?.header?.id;
    appendRecord(this.ledgerDir, {
      provider,
      model,
      sessionId: sessionId === undefined ? undefined : String(sessionId),
      purpose: data?.purpose,
      startedAt: Date.now(),
      endedAt: Date.now(),
      durationMs: 0, // 事件路径拿不到请求起始时刻，耗时留 0 而不是编一个
      ...normalizeUsage(usage),
      finishKind: String(data?.finishReason?.kind ?? 'unknown'),
      ok: true,
      source: 'session/event',
    });
  }

  /** 读账本并聚合；client 通过 RPC 调用它来渲染用量徽章与排序。 */
  summarize() {
    return buildUsageIndex(readLedger(this.ledgerDir));
  }

  /** 最近 N 条明细，用于诊断。 */
  recent(limit = 200) {
    return readLedger(this.ledgerDir).slice(-Math.max(1, Math.min(5000, limit)));
  }
}

/**
 * 加载器读的是 `exports.default ?? exports`，所以 default 必须是类本身。
 * （导出工厂函数会让加载器拿到「造类的函数」，服务永远建不起来。）
 */
export default ModelPickerUsage;

/** 兼容旧形态：部分加载路径仍会调用 apply(ctx)。 */
export function apply(ctx) {
  const service = new ModelPickerUsage(ctx);
  // 旧路径没有 Service 的取件机制，直接把实例挂到 ctx 上供 client 取用。
  try { ctx.modelPickerUsage = service; } catch { /* ctx 不可写则忽略 */ }
  return service;
}

/** 供测试/诊断：读取账本（解析失败的行跳过）。 */
export function readLedger(dir) {
  try {
    const file = join(dir, LEDGER_FILE);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 供测试：把明细聚合为「按 provider/model」的汇总。 */
export function summarize(records) {
  const out = {};
  for (const r of Array.isArray(records) ? records : []) {
    const key = `${r?.provider ?? ''}/${r?.model ?? ''}`;
    const acc = out[key] ?? { key, provider: r?.provider ?? '', model: r?.model ?? '', calls: 0, okCalls: 0, failedCalls: 0, durationMs: 0 };
    acc.calls += 1;
    if (r?.ok === true) acc.okCalls += 1; else acc.failedCalls += 1;
    acc.durationMs += Number.isFinite(r?.durationMs) ? r.durationMs : 0;
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) {
      if (Number.isFinite(r?.[field])) acc[field] = (acc[field] ?? 0) + r[field];
    }
    out[key] = acc;
  }
  return out;
}

export const __test = { normalizeUsage, normalizeFinish, wrapStream, appendRecord, summarize, buildUsageIndex, LEDGER_FILE };
