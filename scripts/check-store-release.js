const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
const versionPath = path.join(projectRoot, 'store', 'package-version.json');
const submittedVersionPath = path.join(projectRoot, 'store', 'last-submitted-version.json');
const expectedIdentity = {
  identityName: 'Elvador.elvador',
  publisher: 'CN=81B62940-3669-4827-A250-7FACEFCE39A5',
  publisherDisplayName: 'Elvador',
  displayName: 'Elvador'
};

function fail(message) {
  console.error(`Store release doğrulaması başarısız: ${message}`);
  process.exit(1);
}

function readVersion(filePath, label) {
  let version;
  try {
    version = JSON.parse(fs.readFileSync(filePath, 'utf8')).version;
  } catch (error) {
    fail(`${label} okunamadı (${path.relative(projectRoot, filePath)}): ${error.message}`);
  }

  if (typeof version !== 'string' || !/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    fail(`${label} X.Y.Z biçiminde, sayısal ve major sürümü sıfırdan büyük olmalı.`);
  }

  const parts = version.split('.').map(Number);
  if (parts.some((part) => part > 65535)) {
    fail(`${label} MSIX'in 0–65535 bileşen sınırını aşıyor.`);
  }

  return { version, parts };
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function validateRelease() {
  const configuredIdentity = packageJson.build?.appx || {};
  for (const [key, expectedValue] of Object.entries(expectedIdentity)) {
    if (configuredIdentity[key] !== expectedValue) {
      fail(`build.appx.${key} değişmiş. Store kimliği ilk submission ile aynı kalmalı (${expectedValue}).`);
    }
  }

  const candidate = readVersion(versionPath, 'store/package-version.json sürümü');
  const submitted = readVersion(submittedVersionPath, 'son gönderilmiş Store sürümü');
  if (compareVersions(candidate.parts, submitted.parts) <= 0) {
    fail(`Yeni Store sürümü (${candidate.version}) son gönderilmiş ${submitted.version} sürümünden büyük olmalı. store/package-version.json dosyasını artırın.`);
  }

  const electronVersion = packageLock.packages?.['node_modules/electron']?.version
    || packageJson.devDependencies?.electron;
  const electronMajor = Number.parseInt(String(electronVersion).split('.')[0], 10);
  if (!Number.isInteger(electronMajor)) {
    fail(`package-lock.json içindeki Electron sürümü çözümlenemedi (${electronVersion}).`);
  }

  const x86Supported = electronMajor <= 43;
  if (!x86Supported) {
    console.log(`::notice::Electron ${electronVersion}, Windows x86 desteği sunmuyor; Store yayını x64-only oluşturulacak.`);
  }

  console.log(`Store sürümü ${candidate.version}; önceki gönderilmiş sürüm ${submitted.version}; Electron ${electronVersion}; x86 ${x86Supported ? 'etkin' : 'desteklenmiyor'}.`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${candidate.version}\nx86_supported=${x86Supported}\n`);
  }

  return { candidate, submitted };
}

const command = process.argv[2];
if (!['check', 'reserve'].includes(command)) {
  console.error('Kullanım: node scripts/check-store-release.js check|reserve');
  process.exit(2);
}

const { candidate } = validateRelease();
if (command === 'reserve') {
  fs.writeFileSync(submittedVersionPath, `${JSON.stringify({ version: candidate.version }, null, 2)}\n`, 'utf8');
  console.log(`Store ${candidate.version} sürümü gönderim için rezerve edildi.`);
}
