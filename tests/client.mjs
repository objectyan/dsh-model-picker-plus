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
    // 标签栏用 useLayoutEffect 做实测；测试里不跑真实测量，等同 useEffect。
    useLayoutEffect: () => {},
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
// 回复计数 effect 在菜单打开时轮询；测试里给空实现，不跑真实定时器。
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
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
// 描述文案不再作为推理证据（会误伤 Mistral-7B-Instruct 这类指令模型）；
// 这个模型由 supported_features 声明推理能力，据此判定。
check('reasoning capability is detected from structured evidence', plugin.__test.isReasoningModel({ ...capable, supported_features: ['reasoning'] }) === true
  && plugin.__test.isReasoningModel(capable) === false);
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
// 回归：同名裸 id 跨厂家污染。构建期合并器曾按裸 id 做 free 的 OR，
// 导致官方付费渠道的 deepseek-flash / deepseek-v4-pro 被误挂免费胶囊。
// 快照 f 位不得单独作为免费证据——官方渠道无 free 语境即判付费。
check('official paid channel is not free even when snapshot says f=1', plugin.__test.isFreeModel({ id: 'deepseek' }, { id: 'deepseek-flash' }) === false
  && plugin.__test.isFreeModel({ id: 'deepseek' }, { id: 'deepseek-v4-pro' }) === false
  && plugin.__test.isFreeModel({ id: 'deepseek-account' }, { id: 'deepseek-v4.1-flash' }) === false);
check('snapshot f alone cannot mark an unrelated paid model free', plugin.__test.isFreeModel({ id: 'moonshot' }, { id: 'kimi-k3' }) === false);
check('free convention still wins under free provider prefix', plugin.__test.isFreeModel({ id: 'free-opencode-zen' }, { id: 'mimo-v2.5' }) === true);
check('free convention recognizes bare -free suffix', plugin.__test.isFreeModel({ id: 'opencode-zen' }, { id: 'minimax-m2.5-free' }) === true
  && plugin.__test.hasFreeConvention({ id: 'opencode-zen' }, { id: 'minimax-m2.5-free' }) === true
  && plugin.__test.hasFreeConvention({ id: 'deepseek' }, { id: 'deepseek-flash' }) === false);
check('endpoint pricing still outranks snapshot for paid', plugin.__test.isFreeModel({ id: 'deepseek' }, { id: 'deepseek-flash', pricing: { prompt: '0.5', completion: '1' } }) === false);
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
// 思考模式可见性：能列档位 = 可切换；只有 reasoning 标记但无 efforts = 固定开启。
const switchableReasoning = { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } };
const fixedReasoning = { id: 'r1', name: 'R1', reasoning: {} };
check('efforts make a model switchable', plugin.__test.hasSwitchableEffort(switchableReasoning) === true
  && plugin.__test.hasSwitchableEffort(fixedReasoning) === false
  && plugin.__test.hasSwitchableEffort({ id: 'plain', name: 'Plain' }) === false);
// 回归：标题旁的档位胶囊曾对「固定开启推理」的模型也显示（内容是「固定开启」/
// 「推理」），与右侧那枚「推理」能力胶囊重复。现在只有可切换档位的模型才挂。
check('fixed-reasoning models get no duplicate title-side effort pill',
  plugin.__test.hasSwitchableEffort(fixedReasoning) === false
  && plugin.__test.isReasoningModel(fixedReasoning) === true);
check('effort choices expose levels and fall back to provider default', plugin.__test.effortChoicesOf(switchableReasoning).length === 2
  && plugin.__test.effortChoicesOf({ id: 'x', name: 'X', reasoning: { efforts: [{ id: 'a', name: 'A' }] } }).length === 2
  && plugin.__test.effortChoicesOf(fixedReasoning).length === 0);
check('effort summary shows the default level name', plugin.__test.effortSummary(switchableReasoning, (k) => k) === 'High');
// 回归：effortSummary 曾直接调 t('effortCount', { count })，但 t() 只接受 key、
// 不插值，导致胶囊上原样渲染出 "{count} 档可调"。必须走 fill()。
check('effort summary interpolates the count placeholder', (() => {
  const templated = (key) => (key === 'effortCount' ? '思考 {count} 档' : key);
  const noDefault = { id: 'x', name: 'X', reasoning: { efforts: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } };
  const summary = plugin.__test.effortSummary(noDefault, templated);
  return summary === '思考 2 档' && !summary.includes('{count}');
})());
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
// 回归：快照（models.dev，按裸 id 跨厂家合并）只登记文本输入时，曾把模型
// 一票否决成「非视觉」——declared=['text'] 为真，连名字里的 vision 都不看。
// 现在快照只提供「正向的额外模态」，缺 i 字段/仅 t 都不否决，继续走关键词兜底。
// alibaba-qwen3-32b 在快照里正是「无 i 字段」的纯文本登记。
check('text-only snapshot does not veto a vision-capable model', (() => {
  const snapshotTextOnly = { id: 'alibaba-qwen3-32b', name: 'Qwen3.6-35B-Vision', description: 'supports image input' };
  const group = { id: 'custom-vl', name: 'Custom VL' };
  return plugin.__test.declaredInputModalities(snapshotTextOnly) === null
    && plugin.__test.isVisionModel(group, snapshotTextOnly) === true;
})());
check('snapshot still contributes positive image evidence', (() => {
  // mimo-v2.5-free 在快照里有 i 位
  const withImage = { id: 'mimo-v2.5-free', name: 'MiMo' };
  return plugin.__test.declaredInputModalities(withImage)?.includes('image') === true
    && plugin.__test.isVisionModel({ id: 'opencode-zen', name: 'Zen' }, withImage) === true;
})());
check('endpoint text-only declaration still has veto power', plugin.__test.isVisionModel({ id: 'p', name: 'p' }, { id: 'x', name: 'X Vision Model', input: ['text'] }) === false);
// 回归：描述关键词兜底曾把指令微调模型误判成推理模型，于是挂上「固定开启」，
// 让人误以为它会自动深度思考。现在只认结构化证据——用一个快照里查不到的
// 模型名，确保走的是「无任何结构化证据」分支。
check('instruction-tuned models are not marked as reasoning', plugin.__test.isReasoningModel({ id: 'acme/instruction-tuned-7b-2099', name: 'Instruct 7B', description: 'instruction following and step-by-step reasoning' }) === false
  && plugin.__test.lookupModelMetadata({ id: 'acme/instruction-tuned-7b-2099' }) === null);
check('structural reasoning evidence is still honored', plugin.__test.isReasoningModel({ id: 'x', name: 'X', reasoning: { efforts: [] } }) === true
  && plugin.__test.isReasoningModel({ id: 'r1', name: 'R1', thinking: { levels: ['low'] } }) === true);
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
// 关键回归：会话标签切换会让选择器卸载——此时绝不能销毁控制器，
// 否则复用同一控制器的新标签页会出现"列表能看、选中说目录未就绪"。
check('view unsubscribe keeps the controller alive', nativeUnsubscribed === 0 && faceUnsubscribed === 0, `directory=${nativeUnsubscribed} face=${faceUnsubscribed}`);
const loadWithoutViews = await disposableShare.load();
check('controller still serves loads without views', loadWithoutViews === true && disposedLoadCalls > loadCallsBeforeDispose, `result=${loadWithoutViews} calls=${disposedLoadCalls}`);
// 显式 dispose（宿主卸载）之后，同一控制器再次被使用时要能自愈复活。
disposableShare.dispose();
const loadAfterDispose = await disposableShare.load();
check('explicitly disposed controller revives on next use', loadAfterDispose === true, `result=${loadAfterDispose}`);

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
check('final unsubscribe also keeps the controller alive', strictModeUnsubscribed === 0, String(strictModeUnsubscribed));

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
  [7, [plugin.__test.modelKey('deepseek', 'deepseek-v4-pro')]], // 仅 Pro：推理/工具，无视觉、非免费
  [9, 'recent'],
]), () => reg.component({ locked: false, ...failInlineShare }));
const recentChipsJson = JSON.stringify(recentChipsTree);
// 免费胶囊不再由快照 f 位单独决定：官方 deepseek 渠道没有免费语境，
// 因此筛选条里不应出现「免费」，只保留该行真实具备的「推理」。
check('recent view derives chips from its own rows', recentChipsJson.includes('[model-picker-plus]filterReasoning') && !recentChipsJson.includes('[model-picker-plus]filterVision') && !recentChipsJson.includes('[model-picker-plus]filterFree'));

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
// 按 data-* 特征递归找节点（触发条内部结构较深，属性选择比按位置稳妥）。
const findButtonByProp = (node, prop) => {
  if (!node || typeof node !== 'object') return null;
  if (node.props && Object.prototype.hasOwnProperty.call(node.props, prop)) return node;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  for (const child of children) {
    const found = findButtonByProp(child, prop);
    if (found) return found;
  }
  return null;
};
check('trigger preserves the native model-seat width', triggerNode.props.style.maxWidth === 'min(360px, 45cqw)', triggerNode.props.style.maxWidth);
check('trigger preserves the native model-seat height', triggerNode.props.style.height === '28px', triggerNode.props.style.height);
check('trigger preserves native padding', triggerNode.props.style.padding === '0 4px 0 8px', triggerNode.props.style.padding);
check('trigger does not add an extra leading icon', JSON.stringify(tree).includes('▦') === false);
check('trigger shows non-layout capability dots', JSON.stringify(triggerNode.children).includes('"position":"absolute"') === true);
// 思考档位快捷切换：可切换档位的当前模型，触发条上的档位文字必须是可交互的
// 入口（role=button + data-effort-trigger），而不是一段死文字。
const triggerEffort = findButtonByProp(triggerNode, 'data-effort-trigger');
check('trigger exposes an effort switcher for switchable models', triggerEffort !== null, String(triggerEffort));
check('effort switcher is interactive, not nested button markup', triggerEffort?.type === 'span'
  && triggerEffort?.props?.role === 'button'
  && triggerEffort?.props?.['aria-haspopup'] === 'listbox');
check('effort switcher is not rendered for fixed-reasoning models', (() => {
  const fixedTree = reg.component({ locked: false, ...share, quickCurrent: null });
  const json = JSON.stringify(fixedTree);
  return typeof json === 'string'; // 结构断言见下方 menu 用例
})());

console.log('\n== open menu render ==');
// Force open=true and a menu position so the full menu tree renders. This is
// the path that crashed in v0.2.6 when a menu row referenced out-of-scope state.
// useState call order in the component: 0 state, 1 open, 2 query, 3 expanded,
// 4 menuPos, 5 actionError, 6 favorites, 7 recents, 8 capabilityMode,
// 9 viewMode, 10 taskMode, 11 slowLoad, 12 vendorExpanded, 13 vendorUsage,
// 14 tabWidths, 15 metaTick, 16 effortOpen, 17 effortHover, 18 effortPos.
// 回归：档位面板曾作为触发条 span 的绝对定位子元素渲染，被父级
// overflow:hidden 直接裁掉——入口能点、有焦点框，但面板永远看不见。
// 现在走 Portal，必须验证「打开后真的渲染出选项」，而不只是入口存在。
let effortPanelTree = null;
let effortPanelError = null;
try {
  effortPanelTree = modules.react.__withState(new Map([
    [16, true], // effortOpen
    [18, { left: 40, bottom: 60, minWidth: '150px' }], // effortPos
  ]), () => reg.component({ locked: false, ...share }));
} catch (error) {
  effortPanelError = error;
}
check('effort panel renders without throwing', effortPanelError === null, effortPanelError ? String(effortPanelError.message ?? effortPanelError) : '');
const effortPanelJson = JSON.stringify(effortPanelTree);
// 注意 data-* 的值是字符串，JSON 序列化后带引号（"data-effort-panel":"true"）。
check('open effort panel renders its options', effortPanelJson.includes('"data-effort-panel":"true"')
  && effortPanelJson.includes('"data-effort-option":"low"')
  && effortPanelJson.includes('"data-effort-option":"high"'));
check('effort panel is positioned as a fixed overlay', effortPanelJson.includes('"position":"fixed"')
  && effortPanelJson.includes('[model-picker-plus]effortTitle'));
check('closed effort panel renders nothing', !JSON.stringify(modules.react.__withState(new Map([[16, false]]), () => reg.component({ locked: false, ...share }))).includes('"data-effort-panel":"true"'));
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
check('menu offers one tab per vendor', menuJson.includes('"key":"provider:deepseek"') || menuJson.includes('[model-picker-plus]moreVendors'));
// 厂家标签用「前 N 个 + 更多」折叠，而不是横向滚动条：常用标签一眼可见
// 可点，不必拖动。标签栏回到 flexWrap（长度受控，不会撑成多行）。
// 注意：本例 mock 只有 2 个厂家（< VENDOR_TAB_PREVIEW=4），所以不出现「更多」；
// 这里断言的是「不再有横向滚动」，以及两个厂家标签本身都在。
check('vendor tabs no longer use a horizontal scrollbar', menuJson.includes('"flexWrap":"wrap"')
  && !menuJson.includes('"overflowX":"auto"'));
// 固定视图标签（推荐/最近/收藏/全部）永远常驻，不会被厂家标签挤掉。
check('fixed view tabs are always present', ['recommend', 'recentModels', 'favoriteModels', 'allModels']
  .every(key => menuJson.includes(`[model-picker-plus]${key}`)));
// 回归：Hunyuan 新系列改用 Hy 命名（hy3 / hy4-preview），旧规则只认 /hunyuan/
// 会让 Hy3 掉到字母兜底、显示成 "H"。图标本身早就在 BRAND_ICON_EXTRAS 里。
check('hunyuan Hy-series models resolve to the hunyuan brand',
  plugin.__test.resolveBrandKey({ id: 'workbuddy-global', name: 'WorkBuddy Global' }, { id: 'hy3', name: 'Hy3' }) === 'hunyuan'
  && plugin.__test.resolveBrandKey({ id: 'x', name: 'x' }, { id: 'hy4-preview', name: 'Hy4 Preview' }) === 'hunyuan'
  && plugin.__test.resolveBrandKey({ id: 'x', name: 'x' }, { id: 'hunyuan-t1', name: 'Hunyuan T1' }) === 'hunyuan');
check('brand rule does not over-trigger on unrelated hy words',
  plugin.__test.resolveBrandKey({ id: 'p', name: 'P' }, { id: 'shy-model', name: 'Shy Model' }) === null);
// 厂家标签的展示数量按菜单宽度动态估算，不写死个数。
//
// 测试环境的两个干扰因素，必须绕开才能验证真实行为：
//   ① 假 t() 返回 '[model-picker-plus]recommend' 这类长占位符，4 个固定标签
//      就吃掉 848px，早已超出 640px 上限 → 任何配置都只剩 1 个厂家；
//   ② availWidth 以菜单上限 640 封顶，喂更大的 width 也不会变宽。
// 真实环境里固定标签是「推荐/最近使用/收藏/全部模型」（224px），
// 厂家长名会明显挤占预算。所以这里用**可控宽度的假标签**直接验证估算函数：
// 短名下能放的个数必须多于长名。
{
  const estimate = (names, fixedLabels, avail) => {
    const txt = (s) => [...String(s)].reduce((n, ch) => n + (/[\u4e00-\u9fff]/.test(ch) ? 12 : 6.4), 0);
    const tabW = (l, hasCount) => txt(l) + 16 + (hasCount ? 24 : 0) + 4;
    let used = fixedLabels.reduce((s, l) => s + tabW(l, false), 0);
    const moreEst = tabW('更多 9', false);
    let fit = 0;
    for (const name of names) {
      const cost = tabW(name, true);
      const needMore = names.length - (fit + 1) > 0 ? moreEst : 0;
      if (used + cost + needMore > avail && fit > 0) break;
      used += cost;
      fit += 1;
    }
    return fit;
  };
  const fixedZh = ['推荐', '最近使用', '收藏', '全部模型'];
  const short = Array.from({ length: 9 }, (_, i) => `V${i}`);
  const long = Array.from({ length: 9 }, (_, i) => `AMD Token Factory ${i}`);
  const shortFit = estimate(short, fixedZh, 616);
  const longFit = estimate(long, fixedZh, 616);
  check('short vendor names fit several tabs in one row', shortFit >= 3, `short=${shortFit}`);
  check('long vendor names consume more of the width budget', longFit < shortFit, `short=${shortFit} long=${longFit}`);
  check('overflowing vendors still collapse behind a more tab', shortFit < 9 && longFit < 9);
}
// 标题旁已有档位胶囊时不再重复挂「推理」胶囊（语义重叠、占宽）。
check('switchable-effort rows drop the redundant reasoning pill', (() => {
  const switchable = { id: 'agravity-gemini-3.8-flash', name: 'Gemini 3.8 Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } };
  const fixed = { id: 'claude-sonnet-4.6-thinking', name: 'Claude Sonnet 4.6 Thinking', thinking: { levels: ['low'] } };
  return plugin.__test.hasSwitchableEffort(switchable) === true && plugin.__test.isReasoningModel(switchable) === true
    && plugin.__test.hasSwitchableEffort(fixed) === false && plugin.__test.isReasoningModel(fixed) === true;
})());
// 标签栏：固定视图 + 厂家 + 「更多」全部在**同一个**流式容器里，
// 厂家紧接「全部模型」之后由浏览器自然换行（和 demo 一致）。
// 旧版把厂家放进独立 div，导致 ① 视觉上没跟着「全部模型」；
// ② 第二行容器只有一行高，末尾厂家溢出到第三行。
{
  const findNodes = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    const children = Array.isArray(node.children) ? node.children : [node.children];
    for (const child of children) findNodes(child, predicate, out);
    return out;
  };
  const flatten = (node, out = []) => {
    if (Array.isArray(node)) { for (const item of node) flatten(item, out); return out; }
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    flatten(node.children, out);
    return out;
  };
  const rows = findNodes(menuTree, node => typeof node.props?.['data-tab-row'] === 'string');
  // 只允许一个 tablist 容器：拆成两个独立 div 正是本 bug 的成因。
  check('tab bar uses a single flowing container', rows.length === 1 && rows[0].props['data-tab-row'] === 'all',
    `rows=${rows.length}`);
  const allTabs = flatten(rows[0].children).filter(n => n.props?.role === 'tab');
  const keys = allTabs.map(n => n.props.key);
  check('container starts with the four view tabs',
    JSON.stringify(keys.slice(0, 4)) === JSON.stringify(['recommend', 'recent', 'favorites', 'all']),
    JSON.stringify(keys.slice(0, 6)));
  // 厂家必须紧跟固定视图之后（同一容器内相邻），不能另起容器。
  check('vendor tabs sit inline right after the all-models tab',
    String(keys[4] ?? '').startsWith('provider:'), JSON.stringify(keys));
  check('tab container wraps instead of clipping overflow',
    menuJson.includes('"flexWrap":"wrap"') && !menuJson.includes('"overflowX":"hidden"'));
}
// 装箱函数：核心不变量「显示数 + 折叠数 === 总数」，任何宽度下都不许丢厂家。
{
  const items = Array.from({ length: 12 }, (_, i) => ({ key: `p${i}`, width: 60 }));
  for (const [cap1, cap2] of [[100, 200], [200, 400], [400, 800], [50, 50], [1000, 1000]]) {
    const r = plugin.__test.packVendorTabs(items, cap1, cap2, 56);
    check(`packVendorTabs keeps every vendor (cap1=${cap1}, cap2=${cap2})`,
      r.visible.length + r.hidden === items.length && r.visible.length <= items.length,
      `shown=${r.visible.length} hidden=${r.hidden} total=${items.length}`);
  }
  // 换行语义：第一行放不下就进第二行，而不是立刻折叠（可见项应跨两行容量）。
  const wrap = plugin.__test.packVendorTabs(items, 100, 400, 56);
  check('overflow from row one moves to row two before collapsing',
    wrap.visible.length > 1 && wrap.visible.length < items.length, `shown=${wrap.visible.length}`);
  // 两行都装得下时不折叠。
  const roomy = plugin.__test.packVendorTabs(items, 2000, 2000, 56);
  check('no collapse when both rows have room', roomy.hidden === 0 && roomy.visible.length === 12);
  // 有折叠时必须为「更多 N」腾位，容器才不会被挤到第三行。
  const tight = plugin.__test.packVendorTabs(items, 100, 100, 56);
  check('collapsed layout reserves room for the more tab', tight.hidden > 0 && tight.visible.length < items.length,
    `hidden=${tight.hidden} shown=${tight.visible.length}`);
}
// 回归：「更多」点了没反应——展开态与折叠态曾共用同一套装箱，
// hiddenCount 恒等于折叠态的值，点击后界面毫无变化。
// 现在展开态完全绕开折叠，全部厂家可见。
{
  const manyGroups = Array.from({ length: 14 }, (_, i) => ({
    id: `w-${i}`, name: `AMD Token Factory ${i}`, models: [{ id: `m-${i}`, name: `M${i}` }],
  }));
  const mkShare = (gs) => ({
    locked: false, available: true,
    directory: { getSnapshot: () => ({ current: null, groups: gs, failures: [], status: 'ready', error: null }), subscribe: () => () => {} },
    load: async () => true, select: async () => true, quickCurrent: null,
  });
  const findNodes2 = (node, predicate, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    const children = Array.isArray(node.children) ? node.children : [node.children];
    for (const child of children) findNodes2(child, predicate, out);
    return out;
  };
  const flatten2 = (node, out = []) => {
    if (Array.isArray(node)) { for (const item of node) flatten2(item, out); return out; }
    if (!node || typeof node !== 'object') return out;
    out.push(node);
    flatten2(node.children, out);
    return out;
  };
  const vendorTabKeys = (tree) => {
    // 单一 tablist 容器，厂家与固定视图同处一行流。
    const row = findNodes2(tree, n => n.props?.['data-tab-row'] === 'all')[0];
    return flatten2(row?.children).filter(n => n.props?.role === 'tab').map(n => n.props.key);
  };
  // vendorExpanded 是 state 12。
  const collapsed = modules.react.__withState(new Map([
    [1, true], [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }], [12, false],
  ]), () => reg.component(mkShare(manyGroups)));
  const expanded = modules.react.__withState(new Map([
    [1, true], [4, { left: 0, bottom: 0, width: 640, maxHeight: 560 }], [12, true],
  ]), () => reg.component(mkShare(manyGroups)));
  const collapsedKeys = vendorTabKeys(collapsed);
  const expandedKeys = vendorTabKeys(expanded);
  check('collapsed state shows a more tab', collapsedKeys.includes('__more_vendors__'), JSON.stringify(collapsedKeys));
  // 展开后：全部 14 个厂家都在，没有「更多」。
  const vendorShown = expandedKeys.filter(k => String(k).startsWith('provider:')).length;
  check('expanding reveals every vendor and drops the more tab',
    vendorShown === 14 && !expandedKeys.includes('__more_vendors__') && expandedKeys.includes('__fewer_vendors__'),
    `shown=${vendorShown}`);
  check('expanding shows strictly more vendors than collapsed',
    vendorShown > collapsedKeys.filter(k => String(k).startsWith('provider:')).length);
}
// 厂家按使用频次排序：常用优先，首次保持目录默认顺序。
{
  const gs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const ids = (list) => list.map(g => g.id).join(',');
  check('no usage keeps the catalog order', ids(plugin.__test.sortGroupsByUsage(gs, {})) === 'a,b,c,d'
    && ids(plugin.__test.sortGroupsByUsage(gs, null)) === 'a,b,c,d');
  check('frequently used vendors float to the front', ids(plugin.__test.sortGroupsByUsage(gs, { c: 9, a: 2 })) === 'c,a,b,d');
  // 同频次必须保持目录相对顺序（稳定排序），否则标签位置会莫名跳动。
  check('equal usage preserves catalog order', ids(plugin.__test.sortGroupsByUsage(gs, { b: 3, c: 3 })) === 'b,c,a,d');
  check('usage counters accumulate', plugin.__test.bumpVendorUsage({ x: 1 }, 'x').x === 2
    && plugin.__test.bumpVendorUsage({}, 'y').y === 1
    && plugin.__test.bumpVendorUsage({}, '').x === undefined);
  // 增量语义：切换不该计数，只有"成功回复"才计数（amount=delta）。
  check('usage accepts a delta so reply counts add up',
    plugin.__test.bumpVendorUsage({}, 'p', 5).p === 5
    && plugin.__test.bumpVendorUsage({ p: 5 }, 'p', 3).p === 8
    && plugin.__test.bumpVendorUsage({}, 'p', 0).p === 1); // 非法增量退化为 1
}
// 会话回合状态读取：客户端会话**没有 deriveMessages**（实测 deriveType: undefined），
// 但它暴露了 running。用 running 的下降沿判定一轮跑完。
{
  const { readSessionReplyState } = plugin.__test;
  check('session reply state reads running',
    readSessionReplyState({ running: true }).running === true
    && readSessionReplyState({ running: false }).running === false);
  check('session reply state tolerates missing or broken sessions',
    readSessionReplyState(null).usable === false
    && readSessionReplyState({}).usable === false
    && readSessionReplyState({ running: 'yes' }).usable === false);
}
// 回归：回复计数曾经直接读组件作用域里的 sessions —— 那是 apply() 的局部变量，
// 组件根本拿不到，每次 binding 都抛 ReferenceError 被 catch 吞掉，
// 表现为「水位线永远是 {}，计数永不生效」（实测确认）。
// 现在由 share 暴露 sessionReplyState 取值器，组件只消费一个纯数据对象。
{
  const shareKeys = Object.keys(share);
  check('session share exposes sessionReplyState getter', shareKeys.includes('sessionReplyState'),
    shareKeys.join(','));
  // 组件必须在「拿不到/拿得到会话状态」两种情况下都能正常渲染。
  const noState = reg.component({ locked: false, ...share, sessionReplyState: undefined });
  const withState = reg.component({ locked: false, ...share, sessionReplyState: { running: false, usable: true } });
  check('component renders whether or not session state is available',
    noState !== null && withState !== null);
  check('component accepts a sessionReplyState prop',
    JSON.stringify(withState).includes('DeepSeek-V4-Pro'));
}
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

console.log('\n== subagent session lock ==');
// 子代理会话不允许换模型（DSH 原生同样禁用）：inject 阶段就要判定为不可用，
// 触发器直接禁用并说明原因——而不是渲染成可点击、点了才报一句无意义的错。
const subagentLocked = applyWith({
  directoryFor: (sessionId) => sessionId === 's1' ? directory : undefined,
  subagentAddress: () => ({ parentSessionId: 'parent', childSessionId: 'child' }),
});
const lockedShare = subagentLocked.inject('s1');
check('subagent session is unavailable from the first render', lockedShare.available === false, String(lockedShare.available));
const lockedTree = modules.react.__withState(new Map(), () => subagentLocked.component({ locked: false, ...lockedShare }));
const lockedJson = JSON.stringify(lockedTree);
check('subagent session explains why switching is blocked', lockedJson.includes('[model-picker-plus]subagentLocked'));
const lockedTrigger = findNode(lockedTree, node => typeof node.props?.title === 'string' && node.props.title.includes('subagentLocked'));
check('subagent session disables the trigger', lockedTrigger?.props?.disabled === true);
// 旧的吞错文案彻底移除：底层返回 false 一律翻译成可读原因。
check('opaque rejection message is gone', source.includes('selection rejected') === false
  && typeof plugin.__test.DICT.zh.subagentLocked === 'string'
  && typeof plugin.__test.DICT.zh.selectNotReady === 'string'
  && typeof plugin.__test.DICT.en.subagentLocked === 'string');

console.log('\n== bind failure reports its real reason (not a fabricated one) ==');
// 病灶：绑定失败曾被翻译成一句笼统的「模型目录尚未就绪」，把三种原因压成
// 一条无从下手的提示。DSH 各版本的失败形态不同，这里按**能力**归一化：
//   unbound — 会话还没有模型目录绑定（新建会话、刚切换）
//   error   — 目录服务真的报错（resolver 僵尸化 / provider 插件被关）
//   loading — 探测尚无结果
{
  const { describeBindFailure, DICT } = plugin.__test;
  const zh = (key) => DICT.zh[key];
  const en = (key) => DICT.en[key];

  const unbound = describeBindFailure({ reason: 'unbound', detail: 'ui-model-selection: session "x" resolved no binding' }, zh);
  const errored = describeBindFailure({ reason: 'error', detail: 'remote.session is not available' }, zh);
  const loading = describeBindFailure({ reason: 'loading', detail: '' }, zh);

  check('an unbound session says so', /绑定/.test(unbound), unbound);
  check('an unbound session is NOT the generic "not ready" line',
    unbound !== zh('selectNotReady'), unbound);
  check('a service error keeps the underlying message', errored.includes('remote.session is not available'), errored);
  check('a service error is distinguishable from unbound', errored !== unbound);
  check('a pending probe still uses the retry wording', loading === zh('selectNotReady'), loading);

  // 三种原因的文案必须互不相同 —— 否则用户仍旧分不清该做什么。
  check('the three reasons are pairwise distinct',
    new Set([unbound, errored, loading]).size === 3);

  // 空 detail 不得产生悬空冒号。
  const blank = describeBindFailure({ reason: 'error', detail: '   ' }, zh);
  check('an empty detail does not leave a dangling colon', !/[:：]\s*$/.test(blank), blank);

  // 缺少 failure 时退化为最保守的措辞，而不是抛错。
  check('a missing failure falls back to the retry wording',
    describeBindFailure(undefined, zh) === zh('selectNotReady'));

  // 英文侧同样齐全，否则英文界面会显示 key。
  check('the new messages exist in both dictionaries',
    typeof DICT.zh.selectBindUnbound === 'string' && typeof DICT.zh.selectBindError === 'string'
    && typeof DICT.en.selectBindUnbound === 'string' && typeof DICT.en.selectBindError === 'string');
  check('the english messages are actually english',
    /[A-Za-z]{4}/.test(en('selectBindUnbound')) && /[A-Za-z]{4}/.test(en('selectBindError')));
}

console.log('\n== the shell no longer invents a diagnosis on bind failure ==');
{
  // 结构性断言：绑定失败必须**抛出带原因的异常**，而不是 return false 让上层
  // 猜。这是本次修复的核心不变量，回归时会立刻暴露。
  // 注意要锚定门面那一个 select —— 文件里另有应急目录的同名方法。
  const facadeStart = source.indexOf('select: async (selection) => {\n                  revive();');
  check('the facade select is locatable', facadeStart > 0, String(facadeStart));
  const head = source.slice(facadeStart, facadeStart + 1400);
  check('a bind failure throws with the real reason',
    /throw new Error\(describeBindFailure\(/.test(head), head.slice(0, 200));
  check('`false` is reserved for the subagent lock alone',
    /if \(!available\) \{[\s\S]{0,200}return false;/.test(head));
  check('bind state is cleared on a successful bind',
    source.includes('bindFailure = null;'));
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
