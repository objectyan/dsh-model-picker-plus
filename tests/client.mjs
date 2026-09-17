import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'client.js'), 'utf8');

function makeReact() {
  let stateOverrides = null;
  let stateCall = 0;
  const React = {
    createElement: (type, props, ...children) => typeof type === 'function'
      ? type({ ...(props ?? {}), children })
      : ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      const index = stateCall++;
      const value = stateOverrides?.has(index)
        ? stateOverrides.get(index)
        : (typeof initial === 'function' ? initial() : initial);
      return [value, () => {}];
    },
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial = null) => ({ current: initial }),
    useCallback: (fn) => fn,
    memo: (component) => component,
    // Run fn() with useState values overridden by call order. The component
    // destructures hooks at factory time, so overrides must live in this
    // closure, not on the React object.
    __withState: (overrides, fn) => {
      const previous = stateOverrides;
      stateOverrides = overrides;
      stateCall = 0;
      try {
        return fn();
      } finally {
        stateOverrides = previous;
        stateCall = 0;
      }
    },
  };
  const ReactDOM = { createPortal: (children) => children };
  return { react: React, 'react-dom': ReactDOM };
}

const modules = makeReact();
global.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      if (id === 'dsh-model-picker-plus') global.__loaded = factory((name) => modules[name]);
    },
  },
};
global.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  body: {},
};
// In-memory localStorage so storage helpers (favorites/recents/runtime-meta) work
// behave exactly as in the browser.
const localStorageData = new Map();
global.localStorage = {
  getItem: (key) => (localStorageData.has(key) ? localStorageData.get(key) : null),
  setItem: (key, value) => { localStorageData.set(key, String(value)); },
  removeItem: (key) => { localStorageData.delete(key); },
};
await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
const plugin = global.__loaded;

console.log('== module and helpers ==');
check('client module loaded', plugin?.name === 'model-picker-plus-client');
check('requires model directory services', plugin.inject.includes('modelDirectories') && plugin.inject.includes('sessions'));
check('zh/en dictionaries aligned', Object.keys(plugin.__test.DICT.zh).length === Object.keys(plugin.__test.DICT.en).length);

const groups = [
  {
    id: 'deepseek', name: 'DeepSeek', models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
    ],
  },
  {
    id: 'free-opencode-zen', name: 'OpenCode Zen', models: [
      { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 Free', description: 'Free coding model' },
    ],
  },
];
const current = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'low' };
check('selection preserves current effort', plugin.__test.selectionFor(groups[0], groups[0].models[1], current).reasoningEffort === 'low');
check('selection uses provider default for another model', plugin.__test.selectionFor(groups[0], groups[0].models[1], null).reasoningEffort === 'high');
check('search filters across provider/model/description', plugin.__test.filterGroups(groups, 'coding')[0].id === 'free-opencode-zen');
check('search can match a provider group', plugin.__test.filterGroups(groups, 'deepseek')[0].models.length === 2);
check('recent/favorite keys round-trip', plugin.__test.splitModelKey(plugin.__test.modelKey('a', 'b')).model === 'b');
const modelIndex = plugin.__test.createModelIndex(groups);
check('model index resolves catalog choices in O(1)', modelIndex.byKey.get(plugin.__test.modelKey('deepseek', 'deepseek-v4-pro'))?.model.id === 'deepseek-v4-pro');
check('model index precomputes capabilities', modelIndex.byKey.get(plugin.__test.modelKey('deepseek', 'deepseek-v4-pro'))?.reasoning === true);
check('duplicate display text is suppressed', plugin.__test.isDistinctText('MiMo V2.5 Free', 'mimo-v2.5-free') === false);
check('capability descriptions remain visible', plugin.__test.isDistinctText('text input · 128K ctx', 'MiMo V2.5 Free', 'mimo-v2.5-free') === true);
const capable = { id: 'x', name: 'X', description: 'text/image/audio input · tools · reasoning · 128K ctx' };
check('tool capability is detected', plugin.__test.hasToolsModel(capable) === true);
check('reasoning description is detected', plugin.__test.isReasoningModel(capable) === true);
check('omni capability is detected', plugin.__test.isOmniModel(capable) === true);
check('capability filter matches tools', plugin.__test.matchesCapability(groups[1], capable, 'tools') === true);
check('coding task accepts reasoning models', plugin.__test.taskMatches(groups[0], groups[0].models[1], 'code') === true);
check('vision task rejects text-only models', plugin.__test.taskMatches(groups[0], groups[0].models[1], 'vision') === false);
check('recommendations prefer current matching task', plugin.__test.recommendedRows(groups, current, [], 'reasoning')[0].model.id === 'deepseek-v4-pro');
check('free task only recommends free providers', plugin.__test.recommendedRows(groups, current, [], 'free').every(row => plugin.__test.isFreeModel(row.group, row.model)) === true);
// 「快速」没有测速数据（健康解耦）：按 当前 > 最近使用 > 名称 排序。
const fastRows = plugin.__test.recommendedRows(groups, current, [plugin.__test.modelKey('deepseek', 'deepseek-v4-flash')], 'fast');
check('fast task prioritizes current then recents', fastRows[0]?.model.id === 'deepseek-v4-pro'
  && fastRows[1]?.model.id === 'deepseek-v4-flash', fastRows.map(row => row.model.id).join(','));
// 免费判定：provider 的 free- 前缀约定 + 模型 id 的 :free 变体后缀（OpenRouter 惯例）。
check('free provider prefix marks models free', plugin.__test.isFreeModel({ id: 'free-openrouter' }, { id: 'x/y' }) === true);
check('free variant suffix marks models free', plugin.__test.isFreeModel({ id: 'openrouter' }, { id: 'meta/llama-3.2:free' }) === true);
check('paid provider models are not marked free', plugin.__test.isFreeModel({ id: 'deepseek' }, { id: 'deepseek-internal-2099' }) === false);
// 品牌图标解析：平台型厂家按模型认牌（OpenRouter 里的 llama → Meta），
// 认不出退厂家 logo（OpenRouter 平台自身），再退字母。
check('platform provider model resolves to its own brand', plugin.__test.resolveBrandKey({ id: 'openrouter', name: 'OpenRouter' }, { id: 'meta/llama-3.2-90b', name: 'Llama 3.2' }) === 'meta');
check('moonshot model resolves to kimi brand', plugin.__test.resolveBrandKey({ id: 'nvidia-nim', name: 'NVIDIA NIM' }, { id: 'moonshotai/kimi-k3', name: 'Kimi K3' }) === 'kimi');
check('qwen model resolves to qwen brand', plugin.__test.resolveBrandKey({ id: 'openrouter', name: 'OpenRouter' }, { id: 'qwen/qwen3-32b', name: 'Qwen3 32B' }) === 'qwen');
check('unresolvable model falls back to platform brand', plugin.__test.resolveBrandKey({ id: 'openrouter', name: 'OpenRouter' }, { id: 'acme/mystery-1', name: 'Mystery' }) === 'openrouter');
check('first-party provider resolves its own brand', plugin.__test.resolveBrandKey({ id: 'deepseek', name: 'DeepSeek' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }) === 'deepseek');
check('custom provider model still resolves by model brand', plugin.__test.resolveBrandKey({ id: 'sx-qwen', name: 'SX-Qwen3.6-35B' }, { id: 'Qwen3.6-35B', name: 'Qwen3.6-35B' }) === 'qwen');
check('truly unknown provider falls back to letter', plugin.__test.resolveBrandKey({ id: 'acme-analytics', name: 'Acme Analytics' }, { id: 'acme-model-1', name: 'Acme Model 1' }) === null);
// 矢量化补位：商汤这类 simple-icons 没有的厂家，靠 HF 头像生成的图标命中。
check('vectorized extras resolve sensenova brand', plugin.__test.resolveBrandKey({ id: 'sensenova', name: 'sensenova' }, { id: 'SenseChat-5', name: 'SenseChat 5' }) === 'sensenova');
check('vectorized extras resolve glm model brand', plugin.__test.resolveBrandKey({ id: 'nvidia-nim', name: 'NIM' }, { id: 'zai-org/glm-5.3-flash', name: 'GLM-5.3-Flash' }) === 'zhipu');
check('vectorized extras resolve grok model brand', plugin.__test.resolveBrandKey({ id: 'openrouter', name: 'OpenRouter' }, { id: 'x-ai/grok-5-fast', name: 'Grok 5 Fast' }) === 'xai');
check('new simple-icons resolve platform brands', plugin.__test.resolveBrandKey({ id: 'ollama-local', name: 'Ollama 本地' }, null) === 'ollama'
  && plugin.__test.resolveBrandKey({ id: 'vllm-prod', name: 'vLLM 生产' }, null) === 'vllm'
  && plugin.__test.resolveBrandKey({ id: 'qianfan', name: '百度千帆' }, null) === 'baidu');
// models.dev 官方标：内嵌 currentColor 且覆盖新品牌（bedrock/azure 等无其他图标源）。
check('official logos embed currentColor svg', Object.keys(plugin.__test.BRAND_LOGOS).length >= 20
  && plugin.__test.BRAND_LOGOS.deepseek?.s.includes('currentColor')
  && plugin.__test.BRAND_LOGOS.stepfun?.vb.length > 0);
check('logo-only brands resolve', plugin.__test.resolveBrandKey({ id: 'aws-bedrock', name: 'AWS Bedrock' }, null) === 'bedrock'
  && plugin.__test.resolveBrandKey({ id: 'azure-cn', name: 'Azure 中国区' }, null) === 'azure');
// 能力判定：结构化模态声明优先于名字关键词（自定义 provider 的 input: [text, image] 场景）。
check('declared input modalities make a plainly-named model vision-capable', plugin.__test.isVisionModel({ id: 'sx-qwen', name: 'SX-Qwen3.6-35B' }, { id: 'Qwen3.6-35B', name: 'Qwen3.6-35B', input: ['text', 'image'] }) === true);
check('modalities.input object shape is honored', plugin.__test.isVisionModel({ id: 'p', name: 'p' }, { id: 'plain-7b', name: 'Plain 7B', modalities: { input: ['text', 'image'] } }) === true);
check('declared text-only modality suppresses name-keyword guessing', plugin.__test.isVisionModel({ id: 'p', name: 'p' }, { id: 'plain-7b', name: 'Plain Image 7B', modalities: { input: ['text'] } }) === false);
check('declared audio modality marks omni', plugin.__test.isOmniModel({ id: 'omni-x', name: 'Omni X', modalities: { input: ['text', 'image', 'audio'] } }) === true);
check('structured tools flag is honored', plugin.__test.hasToolsModel({ id: 'x', name: 'X', tool_call: true }) === true);
check('structured thinking flag is honored', plugin.__test.isReasoningModel({ id: 'x', name: 'X', thinking: { levels: ['low', 'high'] } }) === true);
// 网关直连方言（商汤形态）：input_modalities / supported_features / pricing 全零。
const senseNovaShape = { id: 'sensenova-6.7-flash-lite', name: 'sensenova-6.7-flash-lite', input_modalities: ['text', 'image'], supported_features: ['tools', 'json_mode', 'reasoning'], pricing: { prompt: '0', completion: '0', image: '0', request: '0' } };
check('endpoint input_modalities marks vision', plugin.__test.isVisionModel({ id: 'sensenova', name: 'sensenova' }, senseNovaShape) === true);
check('endpoint supported_features marks tools and reasoning', plugin.__test.hasToolsModel(senseNovaShape) === true && plugin.__test.isReasoningModel(senseNovaShape) === true);
check('all-zero pricing marks free', plugin.__test.isFreeModel({ id: 'sensenova' }, senseNovaShape) === true);
check('non-zero pricing marks paid even under free- prefix', plugin.__test.isFreeModel({ id: 'free-x' }, { id: 'm', pricing: { prompt: '0.5', completion: '1.2' } }) === false);
check('missing pricing falls back to conventions', plugin.__test.isFreeModel({ id: 'free-x' }, { id: 'm' }) === true);
// models.dev 构建期快照：裸 endpoint 模型的能力兜底（运行时零网络、查不到不抛错）。
check('snapshot resolves bare model ids', plugin.__test.lookupModelMetadata({ id: 'qwen3.6-35b' })?.t === 1);
check('snapshot strips provider prefix and free suffixes', plugin.__test.lookupModelMetadata({ id: 'xiaomi/mimo-v2.5-free' })?.r === 1);
check('snapshot misses return null without throwing', plugin.__test.lookupModelMetadata({ id: 'acme/nope-9000' }) === null && plugin.__test.lookupModelMetadata(null) === null && plugin.__test.lookupModelMetadata({}) === null);
check('snapshot gives bare-endpoint models vision', plugin.__test.isVisionModel({ id: 'free-opencode-zen', name: 'OpenCode Zen' }, { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' }) === true);
check('snapshot gives bare-endpoint models tools', plugin.__test.hasToolsModel({ id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free' }) === true);
check('snapshot zero-cost marks free beyond conventions', plugin.__test.isFreeModel({ id: 'opencode-zen' }, { id: 'mimo-v2.5-free' }) === true);
check('explicit declaration still beats snapshot', plugin.__test.isVisionModel({ id: 'p', name: 'p' }, { id: 'kimi-k3', name: 'Kimi K3', input: ['text'] }) === false);
// 运行时补查缓存：合并后同查表链命中，且优先级低于手工快照。
plugin.__test.mergeRuntimeMetadata({ 'brand-new-2099': { i: 'it', t: 1 } });
check('runtime meta cache feeds capability lookup', plugin.__test.hasToolsModel({ id: 'acme/brand-new-2099', name: 'Brand New' }) === true
  && plugin.__test.isVisionModel({ id: 'acme' }, { id: 'brand-new-2099', name: 'Brand New' }) === true);
check('runtime meta cache loses to hand snapshot', plugin.__test.lookupModelMetadata({ id: 'mimo-v2.5' })?.r === 1);
// 补查触发条件：全认识的目录不拉，有未知模型的目录才拉（mock fetch 验证）。
{
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalls += 1; return { ok: true, json: async () => ({ data: [] }) }; };
  globalThis.localStorage = globalThis.localStorage ?? { getItem: () => null, setItem: () => {} };
  const known = [{ id: 'deepseek', models: [{ id: 'deepseek-v4-pro' }] }];
  const unknown = [{ id: 'acme', models: [{ id: 'never-seen-2099' }] }];
  const triggeredKnown = plugin.__test.ensureRuntimeMetadata(known);
  check('runtime meta skips fully-known catalogs', triggeredKnown === false && fetchCalls === 0);
  const triggeredUnknown = plugin.__test.ensureRuntimeMetadata(unknown);
  await new Promise(resolve => setTimeout(resolve, 10));
  globalThis.fetch = originalFetch;
  check('runtime meta fetches on unknown models then throttles', triggeredUnknown === true && fetchCalls === 1
    && plugin.__test.ensureRuntimeMetadata(unknown) === false && fetchCalls === 1);
}

console.log('\n== slot replacement registration ==');
const registrations = [];
const injectedSlots = [];
let localeRegistered = null;
const store = {
  getSnapshot: () => ({ current, groups, failures: [], status: 'ready', error: null }),
  subscribe: () => () => {},
};
const directory = {
  store,
  load: async () => {},
  select: async () => {},
};
const slots = {
  inject(name, callback) { injectedSlots.push(name); return callback(); },
  register(options, component) { registrations.push({ options, component }); },
};
const ctx = {
  get: (name) => name === 'locale'
    ? { register: (ns, dict) => { localeRegistered = { ns, dict }; }, bind: () => (key) => `[model-picker-plus]${key}` }
    : undefined,
  effect: (fn) => { if (typeof fn === 'function') fn(); return () => {}; },
  inject: (names, callback) => {
    check('apply waits for selector services', names.includes('slots') && names.includes('modelDirectories') && names.includes('sessions'), names.join(','));
    return callback({
      slots,
      modelDirectories: { directoryFor: (sessionId) => sessionId === 's1' ? directory : undefined },
      sessions: { subagentAddress: () => undefined },
    });
  },
};
plugin.apply(ctx);
check('registers locale dictionary', localeRegistered?.ns === 'model-picker-plus');
check('injects the native model slot', injectedSlots.includes('conversation.input.model'), injectedSlots.join(','));
check('exactly one single-slot registration', registrations.length === 1, `n=${registrations.length}`);
const reg = registrations[0];
check('registration targets conversation.input.model', reg.options.name === 'conversation.input.model');
check('single-slot registration shadows the built-in', reg.options.priority === -1, String(reg.options.priority));
check('single-slot registration has no list id', reg.options.id === undefined);
const share = reg.options.inject('s1');
check('share proxy reads the real store', share.directory.getSnapshot().status === 'ready' && share.directory.getSnapshot().groups.length === 2);
check('share is available for a normal session', share.available === true);
check('share exposes load/select verbs', typeof share.load === 'function' && typeof share.select === 'function');
check('unknown session shows loading fallback, not a dead end', (() => {
  const s = reg.options.inject('unknown');
  const snap = s.directory.getSnapshot();
  return snap.status === 'loading' && snap.groups.length === 0 && s.available === true;
})());

console.log('\n== inject resilience ==');
// Both directoryFor and subagentAddress can throw while the agents-anywhere
// bridge ('remote.session') flaps. Binding must tolerate that and self-heal.
const applyWith = ({ directoryFor, subagentAddress, binding, remote }) => {
  plugin.__test.resetResilienceState(); // 每个用例从干净的容灾状态开始
  const regs = [];
  const slotMock = {
    inject(name, callback) { return callback(); },
    register(options, component) { regs.push({ options, component }); },
  };
  plugin.apply({
    ...ctx,
    get: (name) => name === 'remote' ? remote : ctx.get(name),
    inject: (names, callback) => callback({
      slots: slotMock,
      modelDirectories: { directoryFor },
      sessions: { subagentAddress, ...(binding ? { binding } : {}) },
    }),
  });
  return { options: regs[0].options, component: regs[0].component, inject: (id) => regs[0].options.inject(id) };
};
const subagentFlap = applyWith({
  directoryFor: (sessionId) => sessionId === 's1' ? directory : undefined,
  subagentAddress: () => { throw new Error('cannot get property "remote.session" without inject'); },
});
const flapShare = subagentFlap.inject('s1');
check('subagent bridge failure keeps directory binding', flapShare.directory.getSnapshot().status === 'ready');
check('subagent bridge failure assumes available', flapShare.available === true, String(flapShare.available));

let directoryCalls = 0;
const directoryFlap = applyWith({
  directoryFor: (sessionId) => {
    directoryCalls += 1;
    if (directoryCalls === 1) throw new Error('cannot get property "remote.session" without inject');
    return sessionId === 's1' ? directory : undefined;
  },
  subagentAddress: () => undefined,
});
const healShare = directoryFlap.inject('s1');
check('directory failure starts with fallback snapshot', healShare.directory.getSnapshot().status === 'loading');
healShare.load(); // on-demand retry path used by menu open
check('binding self-heals on retry', healShare.directory.getSnapshot().status === 'ready');
check('self-healed binding is available', healShare.available === true);
check('self-healed binding serves the real store', healShare.directory.getSnapshot().groups.length === 2);

let nativeUnsubscribed = 0;
let faceUnsubscribed = 0;
let disposedLoadCalls = 0;
const disposableDirectory = {
  store: {
    getSnapshot: () => snapshot,
    subscribe: () => () => { nativeUnsubscribed += 1; },
  },
  load: async () => { disposedLoadCalls += 1; },
  select: async () => {},
};
const disposableEntry = applyWith({
  directoryFor: () => disposableDirectory,
  subagentAddress: () => undefined,
  binding: () => ({
    session: {
      projections: {
        faceOf: () => ({
          getSnapshot: () => ({ next: current }),
          subscribe: () => () => { faceUnsubscribed += 1; },
        }),
      },
    },
  }),
});
const disposableShare = disposableEntry.inject('s1');
const loadCallsBeforeDispose = disposedLoadCalls;
check('directory controller exposes dispose', typeof disposableShare.dispose === 'function');
const releaseDisposableView = disposableShare.directory.subscribe(() => {});
releaseDisposableView();
await new Promise(resolve => setTimeout(resolve, 5));
check('last view unsubscribe disposes directory and projection', nativeUnsubscribed === 1 && faceUnsubscribed === 1, `directory=${nativeUnsubscribed} face=${faceUnsubscribed}`);
const loadAfterDispose = await disposableShare.load();
check('disposed controller rejects later loads', loadAfterDispose === false && disposedLoadCalls === loadCallsBeforeDispose, `result=${loadAfterDispose} calls=${disposedLoadCalls}`);

let strictModeUnsubscribed = 0;
const strictModeEntry = applyWith({
  directoryFor: () => ({
    store: { getSnapshot: () => snapshot, subscribe: () => () => { strictModeUnsubscribed += 1; } },
    load: async () => {},
    select: async () => {},
  }),
  subagentAddress: () => undefined,
});
const strictModeShare = strictModeEntry.inject('s1');
const strictReleaseFirst = strictModeShare.directory.subscribe(() => {});
strictReleaseFirst();
const strictReleaseSecond = strictModeShare.directory.subscribe(() => {});
await new Promise(resolve => setTimeout(resolve, 5));
check('immediate resubscribe cancels pending dispose', strictModeUnsubscribed === 0, String(strictModeUnsubscribed));
strictReleaseSecond();
await new Promise(resolve => setTimeout(resolve, 5));
check('final unsubscribe disposes after resubscribe', strictModeUnsubscribed === 1, String(strictModeUnsubscribed));

let warmupCalls = 0;
const warmupEntry = applyWith({
  directoryFor: () => ({
    store: { getSnapshot: () => snapshot, subscribe: () => () => {} },
    load: async () => { warmupCalls += 1; },
    select: async () => {},
  }),
  subagentAddress: () => undefined,
});
warmupEntry.inject('s1');
warmupEntry.inject('s2');
await Promise.resolve();
check('directory warmup runs once across sessions', warmupCalls === 1, String(warmupCalls));

console.log('\n== fallback directory (bypass dead resolver) ==');
// The resolver instance can be a zombie (its ctx['remote.session'] accessor
// dead) while the underlying RPC client is alive — chat proves it. The
// plugin must then build a directory from ctx.get('remote') + the local
// projection, with the exact same { store, load, select } interface.
let fbProjected = null;
const fbFaceListeners = new Set();
const fbFace = {
  getSnapshot: () => ({ next: fbProjected }),
  subscribe: (listener) => { fbFaceListeners.add(listener); return () => fbFaceListeners.delete(listener); },
};
const fallbackRemote = {
  session: {
    modelCatalog: async () => ({
      ok: true,
      value: {
        default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        groups,
        failures: [],
        routableProviders: ['deepseek', 'free-opencode-zen'],
      },
    }),
    // 模拟真实流程：selectModel 成功后，宿主写入投影帧 → face 更新并通知。
    selectModel: async (request) => {
      fallbackRemote.lastSelect = request;
      fbProjected = {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      };
      for (const listener of [...fbFaceListeners]) listener();
      return { ok: true };
    },
  },
};
const fbEntry = applyWith({
  directoryFor: () => { throw new Error('cannot get property "remote.session" without inject'); },
  subagentAddress: () => undefined,
  binding: () => ({ session: { projections: { faceOf: () => fbFace } } }),
  remote: fallbackRemote,
});
const fbShare = fbEntry.inject('s1');
check('dead resolver falls back to direct-RPC directory', typeof fbShare.directory?.subscribe === 'function');
await fbShare.load();
const fbSnap = fbShare.directory.getSnapshot();
check('fallback directory loads the catalog', fbSnap.status === 'ready' && fbSnap.groups.length === 2, `status=${fbSnap.status}`);
check('fallback directory resolves current from catalog default', fbSnap.current?.model === 'deepseek-v4-flash');
check('fallback directory reports routable providers', fbSnap.routable === true);
const fbSelectOk = await fbShare.select({ provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' });
check('fallback select goes through remote RPC', fbSelectOk === true && fallbackRemote.lastSelect?.model === 'deepseek-v4-pro' && fallbackRemote.lastSelect?.reasoningEffort === 'high');
check('fallback select session id is correct', fallbackRemote.lastSelect?.sessionId === 's1');
check('projection frame backfills current after select', fbShare.directory.getSnapshot().current?.model === 'deepseek-v4-pro');

console.log('\n== fallback directory: piggyback session.remote ==');
// 用户环境实测 ctx.get('remote') 拿不到（fallbackAvailable: false），但
// sessions 服务为聊天捕获的客户端挂在会话对象的普通属性 .remote 上。
const piggyRemote = {
  session: {
    modelCatalog: async () => ({ ok: true, value: { default: null, groups, failures: [], routableProviders: ['deepseek'] } }),
    selectModel: async () => ({ ok: true }),
  },
};
const piggyEntry = applyWith({
  directoryFor: () => { throw new Error('cannot get property "remote.session" without inject'); },
  subagentAddress: () => undefined,
  binding: () => ({
    session: {
      remote: piggyRemote,
      projections: { faceOf: () => ({ getSnapshot: () => ({ next: null }), subscribe: () => () => {} }) },
    },
  }),
  // 不提供 remote：模拟 ctx.get('remote') 不可用的真实环境
});
const piggyShare = piggyEntry.inject('s1');
await piggyShare.load();
check('piggyback binds without ctx.get(remote)', piggyShare.directory.getSnapshot().status === 'ready');
check('piggyback directory serves groups', piggyShare.directory.getSnapshot().groups.length === 2);

console.log('\n== fallback directory: catalog failure ==');
const failingRemote = {
  session: {
    modelCatalog: async () => ({ ok: false, error: { code: 'unavailable', message: 'host catalog broken' } }),
    selectModel: async () => ({ ok: true }),
  },
};
const failEntry = applyWith({
  directoryFor: () => { throw new Error('cannot get property "remote.session" without inject'); },
  subagentAddress: () => undefined,
  remote: failingRemote,
});
const failShare = failEntry.inject('s1');
await failShare.load();
const failSnap = failShare.directory.getSnapshot();
check('fallback catalog failure surfaces as error state', failSnap.status === 'error' && String(failSnap.error).includes('unavailable'));
check('fallback error keeps groups empty, no crash', failSnap.groups.length === 0);

console.log('\n== fallback directory: RPC hang times out ==');
// A catalog RPC that never resolves must be declared dead after the timeout
// — otherwise the UI sits on the "not responding" panel forever.
const hangEntry = applyWith({
  directoryFor: () => { throw new Error('cannot get property "remote.session" without inject'); },
  subagentAddress: () => undefined,
  remote: { session: { modelCatalog: () => new Promise(() => {}), selectModel: async () => ({ ok: true }) } },
});
plugin.__test.setCatalogRpcTimeout(60); // applyWith 会重置，必须在之后设置
const hangShare = hangEntry.inject('s1');
const hangStarted = Date.now();
await hangShare.load();
const hangSnap = hangShare.directory.getSnapshot();
check('hanging catalog RPC times out into error state', hangSnap.status === 'error' && String(hangSnap.error).includes('timeout'), String(hangSnap.error));
check('timeout honored the configured budget', Date.now() - hangStarted < 5000, `${Date.now() - hangStarted}ms`);
plugin.__test.setCatalogRpcTimeout(10000);

console.log('\n== shared catalog TTL ==');
// 新鲜期内重复 load 不再发 RPC（菜单秒开）。
{
  plugin.__test.resetResilienceState();
  let calls = 0;
  let failRefresh = false;
  const ttlRemote = {
    session: {
      modelCatalog: async () => {
        calls += 1;
        return failRefresh
          ? { ok: false, error: { code: 'temporary', message: 'refresh failed' } }
          : { ok: true, value: { default: null, groups, failures: [], routableProviders: [] } };
      },
      selectModel: async () => ({ ok: true }),
    },
  };
  const d = plugin.__test.createFallbackDirectory(ttlRemote, { binding: () => undefined }, 's1');
  await d.load();
  await d.load();
  check('fresh catalog skips refetch within TTL', calls === 1, `calls=${calls}`);
  plugin.__test.setCatalogSwr(0); // 让数据立即「显老」，触发 stale-while-revalidate
  await d.load();
  check('stale-while-revalidate refetches in background', calls === 2, `calls=${calls}`);
  check('swr refetch keeps data ready, no loading flip', d.store.getSnapshot().status === 'ready' && d.store.getSnapshot().groups.length === 2);
  failRefresh = true;
  await d.load();
  check('failed swr refresh keeps last successful catalog', d.store.getSnapshot().status === 'ready' && d.store.getSnapshot().groups.length === 2, JSON.stringify(d.store.getSnapshot()));
}

console.log('\n== fallback directory unit ==');
{
  let fallbackFaceUnsubscribed = 0;
  const miniFace = {
    getSnapshot: () => ({ next: { provider: 'deepseek', model: 'deepseek-v4-pro' } }),
    subscribe: () => () => { fallbackFaceUnsubscribed += 1; },
  };
  const unit = plugin.__test.createFallbackDirectory(
    { session: { modelCatalog: async () => ({ ok: true, value: { default: null, groups, failures: [], routableProviders: ['deepseek'] } }), selectModel: async () => ({ ok: true }) } },
    { binding: () => ({ session: { projections: { faceOf: () => miniFace } } }) },
    's1',
  );
  await unit.load();
  const snap = unit.store.getSnapshot();
  check('projection wins over catalog default', snap.current?.model === 'deepseek-v4-pro', `got ${JSON.stringify(snap.current)} status=${snap.status}`);
  check('fallback directory exposes dispose', typeof unit.dispose === 'function');
  unit.dispose?.();
  check('fallback dispose unsubscribes projection', fallbackFaceUnsubscribed === 1, String(fallbackFaceUnsubscribed));
}
{
  // 没有投影 face 时（旧版 DSH / 异常），select 成功后做乐观回填。
  const noFace = plugin.__test.createFallbackDirectory(
    { session: { modelCatalog: async () => ({ ok: true, value: { default: null, groups, failures: [], routableProviders: ['deepseek'] } }), selectModel: async () => ({ ok: true }) } },
    { binding: () => undefined },
    's1',
  );
  await noFace.load();
  await noFace.select({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  check('optimistic backfill when no projection face', noFace.store.getSnapshot().current?.model === 'deepseek-v4-pro');
}
{
  // 传输层直接抛错时也必须退出 selecting，并保留已经加载成功的目录。
  const throwing = plugin.__test.createFallbackDirectory(
    {
      session: {
        modelCatalog: async () => ({ ok: true, value: { default: null, groups, failures: [], routableProviders: ['deepseek'] } }),
        selectModel: async () => { throw new Error('select transport failed'); },
      },
    },
    { binding: () => undefined },
    's1',
  );
  await throwing.load();
  let selectError = '';
  try {
    await throwing.select({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  } catch (error) {
    selectError = String(error?.message ?? error);
  }
  check('thrown select error reaches caller', selectError === 'select transport failed', selectError);
  check('thrown select restores ready catalog', throwing.store.getSnapshot().status === 'ready' && throwing.store.getSnapshot().groups.length === 2, JSON.stringify(throwing.store.getSnapshot()));
}
{
  const throwingEntry = applyWith({
    directoryFor: () => { throw new Error('dead resolver'); },
    subagentAddress: () => undefined,
    remote: {
      session: {
        modelCatalog: async () => ({ ok: true, value: { default: null, groups, failures: [], routableProviders: ['deepseek'] } }),
        selectModel: async () => { throw new Error('specific selection failure'); },
      },
    },
  });
  const throwingShare = throwingEntry.inject('s1');
  await throwingShare.load();
  let sharedSelectError = '';
  try {
    await throwingShare.select({ provider: 'deepseek', model: 'deepseek-v4-pro' });
  } catch (error) {
    sharedSelectError = String(error?.message ?? error);
  }
  check('share select preserves the concrete failure', sharedSelectError === 'specific selection failure', sharedSelectError);
}

console.log('\n== fast path: local current model ==');
// The session's durable selection lives in the LOCAL projection, so the
// trigger must show it instantly even while the remote catalog is down.
const faceStore = {
  getSnapshot: () => ({ next: { provider: 'deepseek', model: 'deepseek-v4-pro' } }),
  subscribe: () => () => {},
};
const quickEntry = applyWith({
  directoryFor: () => { throw new Error('cannot get property "remote.session" without inject'); },
  subagentAddress: () => undefined,
  binding: () => ({ session: { projections: { faceOf: () => faceStore } } }),
});
const quickShare = quickEntry.inject('s1');
check('local projection exposes current model without directory', quickShare.quickCurrent?.model === 'deepseek-v4-pro');
check('directory snapshot still falls back to loading', quickShare.directory.getSnapshot().status === 'loading');
const quickTree = quickEntry.component({ locked: false, ...quickShare });
check('trigger shows quick current model while directory is down', JSON.stringify(quickTree).includes('deepseek-v4-pro'));

console.log('\n== failed sources listed inline ==');
// 单个来源失败不再整组消失：在「全部模型」清单里显示为带状态的行，
// 展开可见错误详情与重试按钮。
const failInlineSnap = {
  current,
  routable: true,
  groups,
  failures: [{ provider: 'broken-provider', error: 'provider down' }],
  status: 'ready',
  error: null,
};
const failInlineShare = {
  available: true,
  directory: { getSnapshot: () => failInlineSnap, subscribe: () => () => {} },
  load: async () => true,
  select: async () => true,
  quickCurrent: current,
};
const failInlineTree = modules.react.__withState(new Map([
  [1, true], // open
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }], // menuPos
  [9, 'all'], // viewMode：全部模型（按厂家分组）
]), () => reg.component({ locked: false, ...failInlineShare }));
const failInlineJson = JSON.stringify(failInlineTree);
check('failed provider stays in the list', failInlineJson.includes('broken-provider'));
check('failed provider carries an inline status', failInlineJson.includes('[model-picker-plus]sourceFailed'));
check('healthy groups render alongside failures', failInlineJson.includes('DeepSeek') && failInlineJson.includes('OpenCode Zen'));
const descendantsContainButton = (node) => {
  if (!node || typeof node !== 'object') return false;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  return children.some(child => child?.type === 'button' || descendantsContainButton(child));
};
const hasNestedInteractive = (node) => {
  if (!node || typeof node !== 'object') return false;
  if (node.props?.role === 'button' && descendantsContainButton(node)) return true;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  return children.some(hasNestedInteractive);
};
check('model rows avoid nested interactive controls', hasNestedInteractive(failInlineTree) === false);
check('model selection uses native navigation targets', failInlineJson.includes('data-model-option'));
const filteredFailureTree = modules.react.__withState(new Map([
  [1, true],
  [2, 'deepseek'],
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }],
  [9, 'all'],
]), () => reg.component({ locked: false, ...failInlineShare }));
const filteredFailureJson = JSON.stringify(filteredFailureTree);
check('search hides unrelated failed providers', !filteredFailureJson.includes('broken-provider') && filteredFailureJson.includes('DeepSeek'));

console.log('\n== all models groups + per-vendor tabs ==');
// 「全部模型」= 按厂家分组；其后每个厂家一个 tab（只看该厂家平铺模型）。
const allViewJson = JSON.stringify(failInlineTree);
check('all-models view groups models under provider headers', allViewJson.includes('[model-picker-plus]modelsCount'));
check('all-models view lists failed providers', allViewJson.includes('broken-provider'));
check('collapse/expand controls live with the providers section', allViewJson.includes('[model-picker-plus]collapseAll') && allViewJson.includes('[model-picker-plus]expandAll'));
const vendorTree = modules.react.__withState(new Map([
  [1, true],
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }],
  [9, 'provider:free-opencode-zen'],
]), () => reg.component({ locked: false, ...failInlineShare }));
const vendorJson = JSON.stringify(vendorTree);
check('vendor tab does not show collapse/expand controls', !vendorJson.includes('[model-picker-plus]collapseAll'));
check('vendor tab lists only its own models', vendorJson.includes('MiniMax M2.5 Free') && !vendorJson.includes('DeepSeek-V4-Flash'));
check('vendor tab has no provider group headers', !vendorJson.includes('[model-picker-plus]modelsCount'));
check('vendor tab hides other vendors failures', !vendorJson.includes('broken-provider'));
const otherVendorTree = modules.react.__withState(new Map([
  [1, true],
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }],
  [9, 'provider:deepseek'],
]), () => reg.component({ locked: false, ...failInlineShare }));
check('switching vendor tab switches the model list', JSON.stringify(otherVendorTree).includes('DeepSeek-V4-Pro'));
// 厂家 tab + 能力筛选筛空该厂家时，必须显示空态而不是空白。
// 快照数据里 minimax-m2.5-free（Zen 免费变体）没有 image 模态，
// 所以在 Zen 厂家里筛「视觉」会筛空。
const vendorEmptyTree = modules.react.__withState(new Map([
  [1, true],
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }],
  [8, 'vision'], // 能力筛选：视觉（该厂家的免费变体不具备）
  [9, 'provider:free-opencode-zen'],
]), () => reg.component({ locked: false, ...failInlineShare }));
check('vendor tab emptied by capability filter shows empty state', JSON.stringify(vendorEmptyTree).includes('[model-picker-plus]noResults'));
check('rows render capability markers as svg icons', vendorJson.includes('"viewBox":"0 0 16 16"'));
check('vendor rows carry provider badges', vendorJson.includes('data-provider-badge'));
check('vendor tab offers only capabilities its models have', vendorJson.includes('[model-picker-plus]filterFree') && !vendorJson.includes('[model-picker-plus]filterVision'));
// 最近使用：能力筛选对行生效，且选项只按最近清单的能力生成。
// 注意：recents/favorites 存储键由 modelKey 生成（\n 连接），不能手写 '/' 形式。
// 快照数据：v4-flash 有 image 模态、v4-pro 没有——用「视觉」筛选区分两者。
const recentKeys = [plugin.__test.modelKey('deepseek', 'deepseek-v4-flash'), plugin.__test.modelKey('deepseek', 'deepseek-v4-pro')];
const recentFilteredTree = modules.react.__withState(new Map([
  [1, true],
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }],
  [7, recentKeys], // recents：一闪（有视觉）一推理（无视觉）
  [8, 'vision'], // 只看视觉
  [9, 'recent'],
]), () => reg.component({ locked: false, ...failInlineShare }));
const recentFilteredJson = JSON.stringify(recentFilteredTree);
// Pro 被滤掉后只应剩 2 处：触发器按钮 + 「当前模型」卡片；列表行应为 0 处。
check('recent view applies the capability filter to its rows', recentFilteredJson.includes('DeepSeek-V4-Flash') && recentFilteredJson.split('DeepSeek-V4-Pro').length - 1 === 2);
const recentChipsTree = modules.react.__withState(new Map([
  [1, true],
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }],
  [7, [plugin.__test.modelKey('deepseek', 'deepseek-v4-pro')]], // 仅 Pro：免费/推理/工具，无视觉
  [9, 'recent'],
]), () => reg.component({ locked: false, ...failInlineShare }));
const recentChipsJson = JSON.stringify(recentChipsTree);
check('recent view derives chips from its own rows', recentChipsJson.includes('[model-picker-plus]filterReasoning') && recentChipsJson.includes('[model-picker-plus]filterFree') && !recentChipsJson.includes('[model-picker-plus]filterVision'));

const allFailedSnap = {
  current: null,
  routable: null,
  groups: [],
  failures: [{ provider: 'only-broken-provider', error: 'provider unavailable' }],
  status: 'ready',
  error: null,
};
const allFailedTree = modules.react.__withState(new Map([
  [1, true],
  [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }],
]), () => reg.component({
  locked: false,
  available: true,
  directory: { getSnapshot: () => allFailedSnap, subscribe: () => () => {} },
  load: async () => true,
  select: async () => true,
  quickCurrent: null,
}));
const allFailedJson = JSON.stringify(allFailedTree);
check('all-failed catalog lists failed source immediately', allFailedJson.includes('only-broken-provider') && allFailedJson.includes('[model-picker-plus]sourceFailed'));
check('all-failed catalog does not show loading copy', !allFailedJson.includes('[model-picker-plus]loading'));

console.log('\n== trigger render ==');
const tree = reg.component({ locked: false, ...share });
check('component renders with directory share', tree !== null && typeof tree === 'object');
check('trigger shows the current model label', JSON.stringify(tree).includes('DeepSeek-V4-Pro'));
check('trigger shows the selected effort', JSON.stringify(tree).includes('Low'));
const findButton = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button') return node;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  for (const child of children) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
};
const triggerNode = findButton(tree);
check('trigger preserves the native model-seat width', triggerNode.props.style.maxWidth === 'min(360px, 45cqw)', triggerNode.props.style.maxWidth);
check('trigger preserves the native model-seat height', triggerNode.props.style.height === '28px', triggerNode.props.style.height);
check('trigger preserves native padding', triggerNode.props.style.padding === '0 4px 0 8px', triggerNode.props.style.padding);
check('trigger does not add an extra leading icon', JSON.stringify(tree).includes('▦') === false);
check('trigger shows non-layout capability dots', JSON.stringify(triggerNode.children).includes('"position":"absolute"') === true);

console.log('\n== open menu render ==');
// Force open=true and a menu position so the full menu tree renders. This is
// the path that crashed in v0.2.6 when a menu row referenced out-of-scope state.
// useState call order in the component: 0 state, 1 open, 2 query, 3 expanded,
// 4 menuPos, 5 actionError, 6 favorites, 7 recents, 8 capabilityMode,
// 9 viewMode, 10 taskMode, 11 slowLoad, 12 metaTick.
let menuTree = null;
let menuError = null;
try {
  menuTree = modules.react.__withState(new Map([
    [1, true], // open
    [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }], // menuPos
  ]), () => reg.component({ locked: false, ...share }));
} catch (error) {
  menuError = error;
}
check('open menu renders without throwing', menuError === null, menuError ? String(menuError.message ?? menuError) : '');
const menuJson = JSON.stringify(menuTree);
// The test locale binds keys to "[model-picker-plus]<key>" placeholders.
check('menu shows recommendation tab', menuJson.includes('[model-picker-plus]recommend'));
check('menu shows task chips', menuJson.includes('[model-picker-plus]taskCode') && menuJson.includes('[model-picker-plus]taskReasoning'));
check('menu recommends the current model', menuJson.includes('DeepSeek-V4-Pro'));
check('menu explains the recommendation', menuJson.includes('[model-picker-plus]recommendationCode'));
check('menu marks the current recommendation', menuJson.includes('[model-picker-plus]current'));
check('menu shows all-models tab', menuJson.includes('[model-picker-plus]allModels'));
check('menu offers one tab per vendor', menuJson.includes('"key":"provider:deepseek"') && menuJson.includes('"key":"provider:free-opencode-zen"'));
check('vendor tab label carries a model count pill', menuJson.includes('"data-count":2'));
check('filter chips render svg icons', menuJson.includes('"viewBox":"0 0 16 16"'));
check('menu exposes an explicit close action', menuJson.includes('[model-picker-plus]close'));
check('current card exposes change-model action', menuJson.includes('[model-picker-plus]changeModel'));
check('menu shows keyboard navigation hints', menuJson.includes('[model-picker-plus]keyboardNavigate') && menuJson.includes('[model-picker-plus]keyboardUse') && menuJson.includes('[model-picker-plus]keyboardClose'));
check('dialog and search expose accessible names', menuJson.includes('"aria-modal":true') && menuJson.includes('"aria-label":"[model-picker-plus]search"'));
check('tabs and task chips expose selection state', menuJson.includes('"role":"tablist"') && menuJson.includes('"aria-selected":true') && menuJson.includes('"aria-pressed":true'));
check('recommend view hides the redundant capability chips', !menuJson.includes('[model-picker-plus]filterVision'));
// 快照加持后 fixture 全目录四种能力齐备（flash 视觉、Zen 免费、双方推理/工具）。
check('all-models view derives chips from present capabilities', allViewJson.includes('[model-picker-plus]filterReasoning') && allViewJson.includes('[model-picker-plus]filterVision') && allViewJson.includes('[model-picker-plus]filterFree') && allViewJson.includes('[model-picker-plus]filterTools'));
check('provider controls expose expanded state', failInlineJson.includes('"aria-expanded":true'));
const findNode = (node, predicate) => {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  for (const child of children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
};
const dialogNode = findNode(menuTree, node => node.props?.role === 'dialog');
let focusedOption = -1;
let arrowPrevented = false;
const fakeOptions = [0, 1, 2].map(index => ({ focus: () => { focusedOption = index; } }));
if (dialogNode?.props?.ref) dialogNode.props.ref.current = { querySelectorAll: () => fakeOptions };
global.document.activeElement = fakeOptions[0];
dialogNode?.props?.onKeyDown?.({ key: 'ArrowDown', preventDefault: () => { arrowPrevented = true; } });
check('arrow-down moves focus to next model option', focusedOption === 1 && arrowPrevented, `focused=${focusedOption}`);

console.log('\n== slow directory degradation ==');
// A directory stuck in 'loading' (e.g. after a provider plugin was removed)
// must degrade to an explicit not-ready state instead of spinning forever.
const loadingStore = {
  getSnapshot: () => ({ current: null, groups: [], failures: [], status: 'loading', error: null }),
  subscribe: () => () => {},
};
const loadingShare = { available: true, directory: loadingStore, load: () => {}, select: async () => false };
const menuPosOverride = { left: 0, bottom: 0, width: 640, maxHeight: 560 };
// useState call order: 0 state … 11 slowLoad, 12 metaTick.
const spinningTree = modules.react.__withState(new Map([[1, true], [4, menuPosOverride]]), () => reg.component({ locked: false, ...loadingShare }));
check('loading without timeout keeps spinner copy', JSON.stringify(spinningTree).includes('[model-picker-plus]loading'));
const degradedTree = modules.react.__withState(new Map([[1, true], [4, menuPosOverride], [11, true]]), () => reg.component({ locked: false, ...loadingShare }));
const degradedJson = JSON.stringify(degradedTree);
check('slow directory shows not-ready trigger', degradedJson.includes('[model-picker-plus]loadingSlow'));
check('slow directory explains the problem', degradedJson.includes('[model-picker-plus]loadSlowTitle') && degradedJson.includes('[model-picker-plus]loadSlowHint'));
check('slow directory offers a retry', degradedJson.includes('[model-picker-plus]retry'));
check('slow directory hides task recommendations', degradedJson.includes('[model-picker-plus]taskCode') === false);

// 整目录失败（如目录 RPC 超时）显示明确的错误信息与重试入口。
const errorShare = {
  available: true,
  directory: { getSnapshot: () => ({ current: null, groups: [], failures: [], status: 'error', error: 'catalog RPC timeout' }), subscribe: () => () => {} },
  load: async () => false,
  select: async () => false,
};
const errorTree = modules.react.__withState(new Map([[1, true], [4, menuPosOverride]]), () => reg.component({ locked: false, ...errorShare }));
const errorJson = JSON.stringify(errorTree);
check('error state shows the failure message', errorJson.includes('[model-picker-plus]loadFailed'));

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
