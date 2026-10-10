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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'model-picker-plus-usage';
// llm 用来订阅流；storage 可选（用于挑选数据目录），缺失不影响记录。
export const inject = { optional: ['llm', 'storage'] };

const LEDGER_FILE = 'llm-usage.jsonl';
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 超过就轮转一份 .1，避免无限增长

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

export function apply(ctx) {
  const dir = resolveDataDir(ctx);
  try { warnFn = typeof ctx?.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : null; } catch { warnFn = null; }

  // llm 服务可能尚未就绪：用 inject 等它，拿不到就静默退让（插件其余功能照常）。
  if (typeof ctx?.on !== 'function') return;
  try {
    ctx.on('llm/stream', (options, next) => wrapStream(options, next, (record) => {
      appendRecord(dir, record);
    }));
  } catch { /* 订阅失败不影响插件其他部分 */ }

  // 暴露给 client：读账本并聚合。client 侧（platform: web）拿不到宿主的
  // llm/stream 事件，但可以通过这个接口拿到汇总用于展示与排序。
  try {
    ctx.provide?.('modelPickerUsage', {
      indexPath: dir ? join(dir, LEDGER_FILE) : null,
      /** 返回 { "provider/model": {...} } 汇总。 */
      summarize: () => buildUsageIndex(readLedger(dir)),
      /** 返回最近 N 条明细（默认 200），用于诊断。 */
      recent: (limit = 200) => readLedger(dir).slice(-Math.max(1, Math.min(5000, limit))),
    });
  } catch { /* 无 provide 能力时跳过，不影响记账 */ }
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
