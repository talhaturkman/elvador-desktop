const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');

function getPublishConfig(packageJson) {
  const publish = packageJson?.build?.publish;
  if (Array.isArray(publish)) {
    return publish[0] || null;
  }

  return publish || null;
}

function main() {
  const dir = process.argv[2] || 'win-unpacked';
  const outputPath = path.join(repoRoot, 'release', dir, 'resources', 'app-update.yml');

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const publish = getPublishConfig(packageJson);

  if (!publish || publish.provider !== 'github' || !publish.owner || !publish.repo) {
    throw new Error('package.json build.publish must define github owner and repo');
  }

  const yml = [
    `provider: ${publish.provider}`,
    `owner: ${publish.owner}`,
    `repo: ${publish.repo}`,
    `updaterCacheDirName: ${packageJson.name}-updater`,
    ''
  ].join('\n');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yml, 'utf8');
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}

main();
