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
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initial = null) => ({ current: initial }),
    useCallback: (fn) => fn,
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
check('duplicate display text is suppressed', plugin.__test.isDistinctText('MiMo V2.5 Free', 'mimo-v2.5-free') === false);
check('capability descriptions remain visible', plugin.__test.isDistinctText('text input · 128K ctx', 'MiMo V2.5 Free', 'mimo-v2.5-free') === true);
const capable = { id: 'x', name: 'X', description: 'text/image/audio input · tools · reasoning · 128K ctx' };
check('tool capability is detected', plugin.__test.hasToolsModel(capable) === true);
check('reasoning description is detected', plugin.__test.isReasoningModel(capable) === true);
check('omni capability is detected', plugin.__test.isOmniModel(capable) === true);
check('capability filter matches tools', plugin.__test.matchesCapability(groups[1], capable, 'tools') === true);
check('free-hub health keys match provider routes', plugin.__test.healthFor({ 'opencode-zen/x': { status: 'ok' } }, 'free-opencode-zen', 'x')?.status === 'ok');

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
check('share exposes the shared directory store', share.directory === store && share.available === true);
check('share exposes load/select verbs', typeof share.load === 'function' && typeof share.select === 'function');

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

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CHECKS PASSED');
