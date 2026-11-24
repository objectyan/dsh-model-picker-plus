// One-shot: register the locally built 0.7.3 tgz into the desktop profile.
// CLI `dsh plugin add` on desktop only writes dependencies and skips
// dsh.profile.bundles (the Electron-managed-profile rule), which leaves the
// plugin installed-but-not-mounted. This script writes BOTH, so a restart
// actually loads it.
import fs from 'node:fs';
import path from 'node:path';

const profile = 'C:/Users/OY/.dsh/profiles/desktop';
const pkgPath = path.join(profile, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const spec = 'file:D:/OY/Deepseek/dsh-model-picker-plus/dsh-model-picker-plus-0.7.3.tgz';
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-model-picker-plus'] = spec;

pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
if (!pkg.dsh.profile.bundles.includes('dsh-model-picker-plus')) {
  pkg.dsh.profile.bundles.push('dsh-model-picker-plus');
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('dependency =', pkg.dependencies['dsh-model-picker-plus']);
console.log('bundles includes =', pkg.dsh.profile.bundles.includes('dsh-model-picker-plus'));
