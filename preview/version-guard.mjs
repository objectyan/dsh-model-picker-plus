// 一次性自检：证明「VERSION 一致性」这条断言不是真空通过。
// 做法是把 client.js 里的版本临时改成另一个值，看断言逻辑会不会判 false。
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const grab = s => (s.match(/const VERSION = '([^']+)'/) ?? [])[1];

const current = grab(source);
console.log(`  package.json      : ${pkg}`);
console.log(`  client.js VERSION : ${current}`);
console.log(`  一致              : ${current === pkg}`);

// 注入一次漂移：断言必须翻成 false，否则这条测试毫无价值。
const drifted = source.replace(/const VERSION = '[^']+'/, "const VERSION = '9.9.9'");
const injected = grab(drifted);
const wouldFail = injected !== pkg;
console.log(`  注入 9.9.9 后抓到 : ${injected}`);
console.log(`  断言会失败吗      : ${wouldFail ? '是（守卫有效）' : '否（守卫是真空断言！）'}`);

// 更狠的一种：正则本身失效、返回 undefined 时也必须判 false，不能误判通过。
const noMatch = grab('没有版本声明的文件');
console.log(`  正则落空返回      : ${noMatch === undefined ? 'undefined' : noMatch}`);
console.log(`  此时判为不一致吗  : ${noMatch !== pkg ? '是' : '否（危险）'}`);

process.exit(current === pkg && wouldFail && noMatch !== pkg ? 0 : 1);
