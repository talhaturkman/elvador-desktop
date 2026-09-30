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

// 2026-09-30: The CLI hid the first update's app-access HTTP error; verify access and published versions without logging credentials.
async function validateStoreAccess() {
  const { submitted } = validateRelease();
  const secretNames = ['AZURE_AD_TENANT_ID', 'AZURE_AD_APPLICATION_CLIENT_ID', 'AZURE_AD_APPLICATION_SECRET', 'SELLER_ID', 'STORE_PRODUCT_ID'];
  const redactedValues = secretNames.map((name) => process.env[name]).filter(Boolean);
  for (const name of secretNames) {
    if (!process.env[name]?.trim()) throw new Error(`STORE_ACCESS missing_environment=${name}`);
  }

  function safeMessage(value) {
    let message = String(value || 'unknown');
    for (const secret of redactedValues) message = message.split(secret).join('[masked]');
    return message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[masked-token]')
      .replace(/[\r\n]+/g, ' ').slice(0, 600);
  }

  async function requestJson(url, options, phase) {
    let response;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    } catch (_) {
      throw new Error(`STORE_ACCESS phase=${phase} network_request_failed`);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const code = body?.error?.code || body?.code || body?.error;
      const message = body?.error?.message || body?.message || body?.error_description;
      throw new Error(`STORE_ACCESS phase=${phase} http=${response.status} code=${safeMessage(code)} message=${safeMessage(message)}`);
    }
    if (!body) throw new Error(`STORE_ACCESS phase=${phase} invalid_json_response`);
    return body;
  }

  const tokenResponse = await requestJson(`https://login.microsoftonline.com/${encodeURIComponent(process.env.AZURE_AD_TENANT_ID.trim())}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AZURE_AD_APPLICATION_CLIENT_ID.trim(),
      client_secret: process.env.AZURE_AD_APPLICATION_SECRET,
      resource: 'https://manage.devcenter.microsoft.com'
    }).toString()
  }, 'authentication');
  if (!tokenResponse.access_token) throw new Error('STORE_ACCESS authentication_token_missing');
  redactedValues.push(tokenResponse.access_token);

  const headers = { Authorization: `Bearer ${tokenResponse.access_token}` };
  const appUrl = `https://manage.devcenter.microsoft.com/v1.0/my/applications/${encodeURIComponent(process.env.STORE_PRODUCT_ID.trim())}`;
  const app = await requestJson(appUrl, { headers }, 'application');
  if (app.packageIdentityName !== expectedIdentity.identityName) {
    throw new Error('STORE_ACCESS application_identity_mismatch');
  }
  const publishedId = app.lastPublishedApplicationSubmission?.id;
  if (!publishedId) throw new Error('STORE_ACCESS published_submission_missing');
  const publication = await requestJson(`${appUrl}/submissions/${encodeURIComponent(publishedId)}`, { headers }, 'published_submission');
  const versions = [...new Set((publication.applicationPackages || []).map((item) => item.version).filter(Boolean))];
  const expectedVersion = `${submitted.version}.0`;
  if (!versions.length || versions.some((version) => version !== expectedVersion)) {
    throw new Error(`STORE_ACCESS published_version_mismatch expected=${expectedVersion}`);
  }
  console.log(`STORE_ACCESS verified identity=${expectedIdentity.identityName} published_version=${expectedVersion}; no credentials logged.`);
}

const command = process.argv[2];
if (!['check', 'reserve', 'access'].includes(command)) {
  console.error('Kullanım: node scripts/check-store-release.js check|reserve|access');
  process.exit(2);
}

if (command === 'access') {
  validateStoreAccess().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  const { candidate } = validateRelease();
  if (command === 'reserve') {
    fs.writeFileSync(submittedVersionPath, `${JSON.stringify({ version: candidate.version }, null, 2)}\n`, 'utf8');
    console.log(`Store ${candidate.version} sürümü gönderim için rezerve edildi.`);
  }
}
