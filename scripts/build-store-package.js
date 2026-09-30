const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packagePath = path.join(projectRoot, 'package.json');
const packageLockPath = path.join(projectRoot, 'package-lock.json');
const versionPath = path.join(projectRoot, 'store', 'package-version.json');
const electronBuilderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js');
const architecture = String(process.argv[2] || '').toLowerCase();

if (!['x64', 'x86'].includes(architecture)) {
  console.error('Kullanım: npm run build:store:x64 veya npm run build:store:x86');
  process.exit(2);
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
const electronVersion = packageLock.packages?.['node_modules/electron']?.version
  || packageJson.devDependencies?.electron;
const electronMajor = Number.parseInt(String(electronVersion).split('.')[0], 10);

if (!Number.isInteger(electronMajor)) {
  console.error(`Electron sürümü çözümlenemedi: ${electronVersion}`);
  process.exit(2);
}

if (architecture === 'x86' && electronMajor >= 44) {
  console.error(`Electron ${electronVersion} için x86 Windows paketi desteklenmiyor. Electron 43, x86 desteği sunan son ana sürümdür.`);
  process.exit(2);
}

const appx = packageJson.build?.appx;
const requiredIdentityFields = ['identityName', 'publisher', 'publisherDisplayName'];
const missingIdentityFields = requiredIdentityFields.filter((field) => {
  const value = appx?.[field];
  return typeof value !== 'string' || !value.trim() || value.includes('REPLACE_ME');
});

if (missingIdentityFields.length > 0) {
  console.error('Store paketi için Partner Center kimliği henüz yapılandırılmadı.');
  console.error(`Eksik build.appx alanları: ${missingIdentityFields.join(', ')}`);
  console.error('Partner Center > Apps and games > Elvador > Product identity değerlerini build.appx alanlarına ekleyin.');
  process.exit(2);
}

const storeVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8')).version;
if (!/^([1-9]\d*)\.\d+\.\d+$/.test(storeVersion)) {
  console.error(`Geçersiz Store sürümü: ${storeVersion}. 1.0.0 biçiminde, ilk bileşeni sıfırdan büyük olmalı.`);
  process.exit(2);
}

if (!fs.existsSync(electronBuilderCli)) {
  console.error('electron-builder kurulu değil. Önce npm ci çalıştırın.');
  process.exit(2);
}

let exitCode = 1;

try {
  const iconResult = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'generate-store-assets.js')
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true
  });

  if (iconResult.error) {
    throw iconResult.error;
  }
  if (iconResult.status !== 0) {
    throw new Error('Store icon asset generation failed.');
  }

  const buildOutput = path.posix.join('release', 'store', architecture);
  const architectureFlag = architecture === 'x64' ? '--x64' : '--ia32';
  console.log(`Building Store AppX: ${architecture}, Electron ${packageJson.devDependencies.electron}, Store version ${storeVersion}`);

  const result = spawnSync(process.execPath, [
    electronBuilderCli,
    '--win',
    'appx',
    architectureFlag,
    '--publish',
    'never',
    // The legacy bundle contains macOS symlinks that fail to extract on standard Windows accounts.
    '--config.toolsets.winCodeSign=1.1.0',
    `--config.extraMetadata.version=${storeVersion}`,
    `--config.directories.output=${buildOutput}`
  ], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }

  exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Microsoft Store paketi oluşturulamadı: ${error.message}`);
}

process.exitCode = exitCode;
