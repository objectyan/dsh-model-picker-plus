// 注册契约测试：确认三个入口的形态与官方 host 插件一致。
//   index.js       —— 包根（保持 Client 半边），no-op
//   usage-host.js  —— 独立的 Host-only 采集插件（cordis.patch.yml 里单独一行）
//   client.js      —— 浏览器半边
// 这是踩坑最久的地方：形态错一个，ctx 就是残的（inject/effect undefined、
// 服务全取不到、事件永不派发），而且**不会报错**，只是静默不工作。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('== 包根：保持 Client 半边，不做采集 ==');
{
  const mod = await import('../index.js');
  check('导出 apply 函数', typeof mod.apply === 'function');
  check('导出 name', typeof mod.name === 'string' && mod.name.length > 0, mod.name);
  // 根不再声明 llm/connection —— 采集已拆到独立入口，
  // 根缺依赖会拖累整个包（含 Client 半边）的挂载。
  check('根不声明采集依赖', Array.isArray(mod.inject) && mod.inject.length === 0, JSON.stringify(mod.inject));
  check('根不导出 default（避免加载器误取）', mod.default === undefined);
  // 调用不应抛错、也不应产生副作用。
  let threw = null;
  try { mod.apply(); } catch (e) { threw = e; }
  check('apply() 是 no-op 且不抛错', threw === null, String(threw));
}

console.log('\n== 采集入口：与官方 host 插件同形 ==');
{
  const mod = await import('../usage-host.js');
  // 官方可工作的 host 插件（dsh-tool-antigravity）就是这个形状：
  //   const name / const inject = [...] / export function apply(ctx, config)
  check('导出 apply 函数', typeof mod.apply === 'function');
  check('导出 name', typeof mod.name === 'string' && mod.name.length > 0, mod.name);
  check('inject 是普通数组（不是 optional 对象）', Array.isArray(mod.inject), JSON.stringify(mod.inject));
  // 只声明 llm 作硬依赖：记账只需要 llm/stream 事件。
  // connection 仅用于把账本回传给界面，必须走 ctx.get 可选探测——
  // 写进 inject 会让「connection 未就绪」变成「插件挂不上」
  // （实测表现：插件重启后无法启动）。
  check('声明 llm 作硬依赖', mod.inject.includes('llm'), JSON.stringify(mod.inject));
  check('connection 不作硬依赖（未就绪时插件仍须能启动）',
    !mod.inject.includes('connection'), JSON.stringify(mod.inject));
  check('不导出 default', mod.default === undefined);
}

console.log('\n== patch 声明：采集插件是独立一行 ==');
{
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8');
  // 一个包根只能是一个插件；采集需要 llm/connection 依赖，必须独立成行，
  // 否则根会因为缺依赖而整个挂不上（Client 半边也会连带失效）。
  check('包里声明了 model-picker-plus 行', /- id: model-picker-plus\b/.test(patch));
  check('包里声明了独立的 usage 行', /- id: model-picker-plus-usage\b/.test(patch));
  check('usage 行指向 /usage 子路径', /dsh-model-picker-plus\/usage/.test(patch), patch.trim());
}

console.log('\n== 双入口互不干扰 ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'mp-entries-'));
  try {
    const root = await import('../index.js');
    const usage = await import('../usage-host.js');
    // 根 apply 不返回服务；采集 apply 返回服务。两者名字不同，可同时挂载。
    check('两个入口的 name 不同', root.name !== usage.name, `${root.name} vs ${usage.name}`);
    const subs = [];
    const ctx = { logger: { warn: () => {} }, on: (e, h) => subs.push({ e, h }) };
    usage.apply(ctx, { dataDir: dir });
    root.apply();
    check('只有采集入口订阅 llm/stream', subs.length === 1 && subs[0].e === 'llm/stream',
      subs.map(s => s.e).join(','));
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
