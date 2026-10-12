// Host-owned per-request ledger. No prompts, responses or credentials are stored.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const name = 'model-picker-plus-usage';
// 只用 llm 作硬依赖：记账本身只需要 llm/stream 事件。
// connection 是**可选**的（仅用于把账本回传给界面），用 ctx.get 探测即可。
// 曾经把它写进 inject 数组，等于声明「没有 connection 就不许挂载」——
// 启动早期 connection 尚未就绪时，插件会整个挂不上（实测表现为插件无法启动）。
export const inject = ['llm'];
export const LEDGER_FILE = 'llm-usage.jsonl';
export const RPC_NAMESPACE = 'model-picker-plus-usage';
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeUsage(usage) {
  if (!object(usage)) return null;
  const result = {};
  for (const field of TOKEN_FIELDS) if (count(usage[field])) result[field] = usage[field];
  return Object.keys(result).length ? result : null;
}
export function normalizeFinish(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown';
  const result = { finishKind: kind, ok: ['stop', 'tool-calls'].includes(kind), truncated: kind === 'max-tokens' };
  if (reason?.failure) {
    // Do not copy arbitrary failure messages: they may include request bodies or secrets.
    result.error = { code: String(reason.failure.code ?? 'UNKNOWN') };
    if (count(reason.failure.status)) result.error.status = reason.failure.status;
  }
  return result;
}

// Each wrapper invocation gets a distinct local ID. Equal token counts are NOT a duplicate.
// Record only llm/stream: assistant events are projections of the same call, not more calls.
export function wrapStream(options, next, onRecord, clock = {}) {
  const wall = clock.wall ?? Date.now;
  const mono = clock.mono ?? (() => performance.now());
  return (async function* () {
    const requestId = randomUUID();
    const startedAt = wall();
    const startedMono = mono();
    let usage = null, finish = null, threw = false, errorCode, firstChunkAt, firstChunkMs;
    try {
      const inner = next();
      for await (const chunk of inner) {
        if (firstChunkMs === undefined) { firstChunkMs = Math.max(0, mono() - startedMono); firstChunkAt = wall(); }
        if (chunk?.type === 'usage') {
          const update = normalizeUsage(chunk.usage);
          if (update) usage = { ...(usage ?? {}), ...update };
        }
        if (chunk?.type === 'finish') finish = normalizeFinish(chunk.reason);
        yield chunk;
      }
    } catch (error) {
      threw = true;
      errorCode = String(error?.code ?? (options?.signal?.aborted ? 'ABORTED' : 'STREAM_THROW'));
      throw error;
    } finally {
      const endedAt = wall();
      const state = threw
        ? { finishKind: options?.signal?.aborted ? 'aborted' : 'threw', ok: false, error: { code: errorCode } }
        : finish ?? { finishKind: 'incomplete', ok: false };
      const row = {
        schemaVersion: 2, requestId, source: 'llm/stream',
        provider: String(options?.provider ?? ''), model: String(options?.model ?? ''),
        startedAt, endedAt, durationMs: Math.max(0, Math.round(mono() - startedMono)),
        timezoneOffsetMinutes: new Date(startedAt).getTimezoneOffset(),
        usageReported: usage !== null, ...(usage ?? {}), ...state,
      };
      if (typeof options?.sessionId === 'string') row.sessionId = options.sessionId;
      if (typeof options?.purpose === 'string') row.purpose = options.purpose;
      if (typeof options?.reasoningEffort === 'string') row.reasoningEffort = options.reasoningEffort;
      if (firstChunkMs !== undefined) { row.firstChunkMs = Math.round(firstChunkMs); row.firstChunkAt = firstChunkAt; }
      // Accounting failure must never alter chunks, throws, cancellation or cleanup.
      try { await onRecord(row); } catch { /* reported by ledger owner */ }
    }
  })();
}

// Reasoning is a subset of output, not an additional billing bucket.
export function totalOf(row) {
  if (count(row.totalTokens)) return { value: row.totalTokens, exact: true };
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  const value = fields.reduce((sum, key) => sum + (count(row[key]) ? row[key] : 0), 0);
  return { value, exact: fields.every(key => count(row[key])) };
}

export function buildUsageIndex(records) {
  const out = Object.create(null), ids = new Set();
  // 旧版账本（0.6.0-alpha.1）没有 requestId，且同一次调用会被
  // llm/stream 与 session/event 各记一条（source 字段可区分）。
  // 这里按「provider|model|token 指纹」折叠**旧格式**记录，避免历史数据
  // 把调用次数算成两倍；新格式一律以 requestId 为准，绝不按指纹去重
  // ——两次真实调用用量完全相同是合法的，不能被误删。
  const legacySeen = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (!object(r) || typeof r.provider !== 'string' || typeof r.model !== 'string') continue;
    if (r.requestId) {
      if (ids.has(r.requestId)) continue;
      ids.add(r.requestId);
    } else {
      const legacyKey = [r.provider, r.model, r.inputTokens ?? '', r.outputTokens ?? '',
        r.cacheReadTokens ?? '', r.totalTokens ?? '', r.startedAt ?? ''].join('|');
      if (legacySeen.has(legacyKey)) continue;
      legacySeen.add(legacyKey);
    }
    const key = `${r.provider}/${r.model}`;
    const a = out[key] ??= { key, provider: r.provider, model: r.model, calls: 0, okCalls: 0, failedCalls: 0,
      truncatedCalls: 0, unknownCalls: 0, usageCalls: 0, missingUsageCalls: 0, durationMs: 0, tokens: 0, exactTotalCalls: 0,
      sessions: Object.create(null) };
    a.calls++;
    if (r.truncated) a.truncatedCalls++;
    else if (r.ok === true) a.okCalls++;
    else if (['threw', 'error', 'aborted'].includes(r.finishKind) || r.ok === false) a.failedCalls++;
    else a.unknownCalls++;
    const reported = r.usageReported ?? TOKEN_FIELDS.some(key => count(r[key]));
    if (reported) { a.usageCalls++; const total = totalOf(r); a.tokens += total.value; if (total.exact) a.exactTotalCalls++; }
    else a.missingUsageCalls++;
    if (count(r.durationMs)) a.durationMs += r.durationMs;
    for (const field of TOKEN_FIELDS) if (count(r[field])) a[field] = (a[field] ?? 0) + r[field];
    if (typeof r.sessionId === 'string') a.sessions[r.sessionId] = (a.sessions[r.sessionId] ?? 0) + 1;
    if (count(r.startedAt)) {
      a.firstAt = Math.min(a.firstAt ?? r.startedAt, r.startedAt);
      a.lastAt = Math.max(a.lastAt ?? r.startedAt, r.endedAt ?? r.startedAt);
    }
  }
  for (const a of Object.values(out)) {
    a.cacheHitRate = count(a.cacheReadTokens) && count(a.inputTokens)
      && a.inputTokens + a.cacheReadTokens + (a.cacheWriteTokens ?? 0) > 0
      ? a.cacheReadTokens / (a.inputTokens + a.cacheReadTokens + (a.cacheWriteTokens ?? 0)) : null;
    a.tokensExact = a.usageCalls === a.calls && a.exactTotalCalls === a.calls;
  }
  return out;
}
export const summarize = buildUsageIndex;

export function appendRecord(dir, row, maxBytes = 8 * 1024 * 1024) {
  if (!dir) return false;
  const file = join(dir, LEDGER_FILE);
  mkdirSync(dir, { recursive: true });
  // Never overwrite/delete older archives: the ledger is cumulative history.
  if (existsSync(file) && statSync(file).size >= maxBytes) {
    renameSync(file, join(dir, `llm-usage.${Date.now()}.${randomUUID()}.jsonl`));
  }
  if (existsSync(file) && statSync(file).size > 0) {
    const text = readFileSync(file, 'utf8');
    if (!text.endsWith('\n')) appendFileSync(file, '\n', 'utf8'); // isolate a torn tail
  }
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return true;
}
export function readLedger(dir) {
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter(file => file === LEDGER_FILE || /^llm-usage\.[^.]+\.[^.]+\.jsonl$/.test(file) || file === `${LEDGER_FILE}.1`).sort();
  const rows = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      try { const row = JSON.parse(line); if (object(row)) rows.push(row); } catch { /* torn/corrupt lines */ }
    }
  }
  return rows.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/**
 * Register the usage snapshot endpoint on Connection.
 *
 * 用 `connection.fetch.register({ path: '/api/<ns>/<endpoint>', ... })`，
 * 与官方可工作的 dsh-tool-antigravity 同款。踩过的两条错路：
 *   · `rpc.intercept('/api', ...)` —— 共享通道只能有一个 interceptor，
 *     已被 antigravity 占用 → `already has an interceptor`；
 *   · `rpc.handle('name', ...)` —— 通道名必须以 `/` 开头
 *     （CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/）→ `invalid or reserved RPC channel`。
 * 精确 Fetch 路由天然支持多方共存（只有 path 完全相同才冲突），
 * 认证 / 来源检查 / peer 准入仍由 Connection 负责，不新开未认证路由。
 *
 * 返回 true 表示注册成功，false 表示宿主没有可用的 Fetch 通道。
 */
export function registerUsageRpc(connection, service) {
  const endpoint = 'snapshot';
  const method = `${RPC_NAMESPACE}/${endpoint}`;

  const handle = async (requestedMethod, payload) => {
    const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });
    // method 必须与本路由一致，避免被当成别的端点的入口。
    if (requestedMethod !== method) return fail('BAD_REQUEST', 'Method does not match its endpoint');
    if (!object(payload)) return fail('BAD_REQUEST', 'Expected an object');
    const allowed = ['sessionId', 'provider', 'model', 'limit'];
    if (Object.keys(payload).some(key => !allowed.includes(key))) return fail('BAD_REQUEST', 'Unknown query field');
    for (const key of ['sessionId', 'provider', 'model']) {
      if (payload[key] !== undefined && typeof payload[key] !== 'string') return fail('BAD_REQUEST', `Invalid ${key}`);
    }
    if (payload.limit !== undefined && (!Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 1000)) {
      return fail('BAD_REQUEST', 'limit must be 1..1000');
    }
    try {
      return { ok: true, value: service.snapshot(payload) };
    } catch { return fail('LEDGER_READ_FAILED', 'Could not read usage history'); }
  };

  const fetch = connection?.fetch;
  if (typeof fetch?.register !== 'function') return false;
  fetch.register({
    path: `/api/${RPC_NAMESPACE}/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body;
      try { body = await request.json(); } catch { return new Response('invalid JSON', { status: 400 }); }
      const rpcId = body?.rpcId;
      if (body?.type !== 'client-request' || typeof rpcId !== 'string') {
        return new Response('invalid usage request', { status: 400 });
      }
      let result;
      try { result = await handle(body.method, body.payload); }
      catch { result = { ok: false, error: { code: 'INTERNAL', message: 'Usage request failed', details: {} } }; }
      // 响应信封必须回同一个 rpcId —— client 会校验一致性。
      return Response.json({ type: 'server-response', rpcId, result });
    },
  });
  return true;
}

export function apply(ctx, config = {}) {
  // Explicit plugin-owned path or standard DSH_HOME, never guessed storage service properties.
  const dir = config.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-model-picker-plus');
  // 目录不可写时绝不能抛出——采集是旁路功能，插件必须照常挂载
  // （否则一个统计功能会把整个包的加载带崩，这是之前踩过的坑）。
  try { mkdirSync(dir, { recursive: true }); } catch { /* 记不了账而已，不影响插件 */ }
  let persistedCalls = 0, writeErrors = 0, lastWriteAt = null;
  const service = {
    ledgerDir: dir, ledgerPath: join(dir, LEDGER_FILE),
    summarize: () => buildUsageIndex(readLedger(dir)),
    recent: (limit = 200) => readLedger(dir).slice(-limit),
    snapshot(query = {}) {
      const records = readLedger(dir).filter(r => (!query.sessionId || r.sessionId === query.sessionId)
        && (!query.provider || r.provider === query.provider) && (!query.model || r.model === query.model));
      return { schemaVersion: 2, models: buildUsageIndex(records), recent: records.slice(-(query.limit ?? 100)).reverse(),
        status: { collecting: true, persistedCalls, writeErrors, lastWriteAt, recordCount: records.length,
          historicalDuplicatesExcluded: false, note: 'Collection starts when enabled; older provider usage may be incomplete.' } };
    },
  };
  // Missing ctx.on (bare test contexts, degraded hosts) must not throw: the
  // ledger simply collects nothing rather than breaking plugin load.
  if (typeof ctx?.on === 'function') {
    ctx.on('llm/stream', (options, next) => wrapStream(options, next, row => {
      try { if (appendRecord(dir, row)) { persistedCalls++; lastWriteAt = row.endedAt; } }
      catch { writeErrors++; try { ctx.logger?.warn?.('model-picker-plus: usage write failed'); } catch {} }
    }));
  }
  // RPC 注册：client 侧界面靠它读账本。安静失败会让界面永远没数据，
  // 所以把结果写进 attach.log —— 「有没有注册上」必须可观测。
  const note = (line) => {
    try { appendFileSync(join(dir, 'attach.log'), `${line}\n`, 'utf8'); } catch { /* 诊断写不了就算了 */ }
  };
  note(`USAGE-APPLY ${new Date().toISOString()} on=${typeof ctx?.on} inject=${typeof ctx?.inject} get=${typeof ctx?.get}`);
  const tryRegister = (connection, via) => {
    const hasFetch = typeof connection?.fetch?.register === 'function';
    if (!hasFetch) { note(`RPC-SKIP connection via ${via} exposes no fetch.register`); return false; }
    try {
      const ok = registerUsageRpc(connection, service);
      note(ok
        ? `RPC-OK fetch.register(/api/${RPC_NAMESPACE}/snapshot) via ${via}`
        : `RPC-SKIP ${via} reported no usable fetch channel`);
      return ok;
    } catch (error) {
      note(`RPC-FAIL ${via}: ${error?.message ?? error}`);
      return false;
    }
  };
  // 注册成功后就不再重试，避免重复注册（handle 重复注册会互相覆盖）。
  let registered = false;
  const attempt = (via) => {
    if (registered) return true;
    try {
      const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
      if (!conn) { note(`RPC-PENDING connection not ready (${via})`); return false; }
      registered = tryRegister(conn, via);
      return registered;
    } catch (error) {
      note(`RPC-GET-FAIL ${via}: ${error?.message ?? error}`);
      return false;
    }
  };
  // connection 不写进顶层 inject（那会让「connection 未就绪」变成「插件挂不上」），
  // 改用 **ctx.inject(deps, cb)**：它注册的是一个子插件，只在该依赖就绪时被回调，
  // **不会阻塞父插件挂载**，也不需要自己轮询/计时器。
  // 这比定时器重试可靠得多——实测定时器方案在宿主的计时器服务未就绪时会静默不执行。
  attempt('apply');
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['connection'], (scope) => {
        if (registered) return;
        const conn = scope?.connection ?? (typeof scope?.get === 'function' ? scope.get('connection') : undefined);
        if (conn) registered = tryRegister(conn, 'ctx.inject([connection])');
      });
    } catch (error) {
      note(`RPC-INJECT-FAIL ${error?.message ?? error}`);
    }
  }
  return service;
}
export const __test = { normalizeUsage, normalizeFinish, wrapStream, appendRecord, summarize, buildUsageIndex, totalOf, LEDGER_FILE };
