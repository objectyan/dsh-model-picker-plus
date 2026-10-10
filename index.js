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
 * 注册形态（最终定论，参照官方能工作的 host 插件 dsh-tool-antigravity）：
 *   `const name` + `const inject = [...]` + `export function apply(ctx, config)`
 *   —— 就是最朴素的那一种。apply 里的 ctx 是**真实的宿主 context**，
 *   可以直接 `ctx.get('服务')` / `ctx.on('事件')`，不需要任何技巧。
 *
 * 踩过的坑（别重犯）：
 *   1. 曾以为要 `class extends Service` —— 但 @deepseek-ai/cordis 只在
 *      app.asar 内部，插件根本拿不到那个基类，退化成普通类后 ctx 是残的；
 *   2. 曾用 `Symbol.for('cordis.initHooks')` 挂载 —— 同样是拿不到真 context
 *      的补救，实测该 context 里 inject/effect 皆 undefined、所有服务取不到；
 *   3. `export default class` / 工厂函数也都不对。
 *   真正的答案一直是最简单的那种：普通 apply 函数 + 顶层 inject 数组。
 */
export const name = 'model-picker-plus';
// storage 用来挑数据目录；缺失也能工作（退回 ~/.dsh），所以走 optional。
export const inject = { optional: ['storage'] };

/** Debug diagnostics are written here so a failed mount is never silent. */
function noteTo(dir, line) {
  try {
    const target = dir ?? join(homedir(), '.dsh', 'dsh-model-picker-plus');
    mkdirSync(target, { recursive: true });
    appendFileSync(join(target, 'attach.log'), `${line}\n`, 'utf8');
  } catch { /* 诊断写不了就算了 */ }
}

/**
 * Mount the host-side usage ledger.
 *
 * @param ctx - the real host context (services reachable via ctx.get).
 */
export function apply(ctx, _config = {}) {
  const ledgerDir = resolveDataDir(ctx);
  try { warnFn = typeof ctx?.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : null; } catch { warnFn = null; }

  noteTo(ledgerDir, `APPLY ${new Date().toISOString()} get=${typeof ctx?.get} on=${typeof ctx?.on} inject=${typeof ctx?.inject}`);

  // 诊断：一次性把 ctx 的能力面记下来，便于区分「服务不在位」与「事件不到」。
  try {
    const probe = [];
    for (const svc of ['llm', 'sessions', 'storage']) {
      let viaGet = 'n/a';
      try { viaGet = typeof ctx.get === 'function' ? (ctx.get(svc) === undefined ? 'undef' : 'hit') : 'n/a'; } catch (e) { viaGet = `err:${e?.message ?? e}`; }
      probe.push(`${svc}=${viaGet}`);
    }
    noteTo(ledgerDir, `services ${probe.join(' ')}`);
  } catch { /* 诊断失败不影响服务 */ }

  const record = (row) => appendRecord(ledgerDir, row);

  // 订阅 waterfall：每次流式调用都经过这里，带 provider/model 与完整 usage。
  // 真实 context 上无需任何作用域技巧（官方 antigravity 同样直接 ctx.on）。
  try {
    ctx.on('llm/stream', (options, next) => {
      return wrapStream(options, next, record);
    });
    noteTo(ledgerDir, 'OK: subscribed llm/stream');
  } catch (error) {
    noteTo(ledgerDir, `FAIL llm/stream: ${error?.message ?? error}`);
  }

  // 兜底：从会话事件里读 usage（官方 token-meter 的取法），
  // 覆盖 llm/stream 因宿主差异漏掉的情况。
  try {
    ctx.on('session/event', (session, event) => {
      try { observeSessionEvent(session, event, record); } catch { /* 观测失败不影响会话 */ }
    });
    noteTo(ledgerDir, 'OK: subscribed session/event');
  } catch (error) {
    noteTo(ledgerDir, `FAIL session/event: ${error?.message ?? error}`);
  }

  // 暴露给 client：读账本并聚合。
  return {
    ledgerDir,
    ledgerPath: ledgerDir ? join(ledgerDir, LEDGER_FILE) : null,
    summarize: () => buildUsageIndex(readLedger(ledgerDir)),
    recent: (limit = 200) => readLedger(ledgerDir).slice(-Math.max(1, Math.min(5000, limit))),
  };
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

/**
 * 从会话事件里捞一次调用的 usage（官方 token-meter 的取法）。
 *
 *   - `assistant/message` 且 data.usage 存在 → 直接用它；
 *   - 否则看 data.stream 里**最后一个 usage chunk**。
 * provider/model 来自 assistant 消息自身的 source（messageRoute）。
 * 作为 llm/stream 的兜底：那条 waterfall 若因宿主版本差异漏掉，这条仍在。
 */
export function observeSessionEvent(session, event, record) {
  const type = event?.type;
  const data = event?.data;
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return null;

  const usage = data?.usage ?? lastUsageChunk(data?.stream);
  if (!usage) return null;

  const route = data?.message?.source ?? data?.source ?? {};
  const provider = String(route.provider ?? '');
  const model = String(route.model ?? '');
  // 没有归属就不记：宁可少一条，也不往账本里塞无法归因的脏数据。
  if (provider === '' && model === '') return null;

  const sessionId = session?.id ?? session?.sessionId ?? session?.header?.id;
  const row = {
    provider,
    model,
    sessionId: sessionId === undefined ? undefined : String(sessionId),
    purpose: data?.purpose,
    startedAt: Date.now(),
    endedAt: Date.now(),
    // 事件路径拿不到请求起始时刻，耗时留 0 而不是编一个看似合理的数。
    durationMs: 0,
    ...(normalizeUsage(usage) ?? {}),
    finishKind: String(data?.finishReason?.kind ?? 'unknown'),
    ok: true,
    source: 'session/event',
  };
  record(row);
  return row;
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

export const __test = { normalizeUsage, normalizeFinish, wrapStream, appendRecord, summarize, buildUsageIndex, observeSessionEvent, lastUsageChunk, LEDGER_FILE };
