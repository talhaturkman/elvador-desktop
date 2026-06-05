const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: options.encoding || 'utf8',
    stdio: options.stdio || 'pipe'
  });
}

function getRepoRoot() {
  return runGit(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

const repoRoot = getRepoRoot();
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageLockPath = path.join(repoRoot, 'package-lock.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseVersion(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported package version: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function localTagExists(tagName) {
  try {
    runGit(['rev-parse', '-q', '--verify', `refs/tags/${tagName}`], {
      cwd: repoRoot,
      stdio: 'ignore'
    });
    return true;
  } catch (_) {
    return false;
  }
}

function remoteTagExists(tagName) {
  try {
    runGit(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tagName}`], {
      cwd: repoRoot,
      stdio: 'ignore'
    });
    return true;
  } catch (error) {
    if (error.status === 2) {
      return false;
    }
    throw new Error(`Could not check remote tag ${tagName}`);
  }
}

function tagExists(tagName) {
  return localTagExists(tagName) || remoteTagExists(tagName);
}

function findNextPatchVersion(currentVersion) {
  const parsed = parseVersion(currentVersion);

  while (true) {
    parsed.patch += 1;
    const nextVersion = formatVersion(parsed);
    if (!tagExists(`v${nextVersion}`)) {
      return nextVersion;
    }
  }
}

function bumpPackageVersion(nextVersion) {
  const packageJson = readJson(packageJsonPath);
  packageJson.version = nextVersion;
  writeJson(packageJsonPath, packageJson);

  if (fs.existsSync(packageLockPath)) {
    const packageLock = readJson(packageLockPath);
    packageLock.version = nextVersion;
    if (packageLock.packages && packageLock.packages['']) {
      packageLock.packages[''].version = nextVersion;
    }
    writeJson(packageLockPath, packageLock);
  }
}

function hasChanges() {
  return runGit(['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0;
}

function getCurrentVersion() {
  return readJson(packageJsonPath).version;
}

function createAndPushTag(version) {
  const tagName = `v${version}`;
  if (tagExists(tagName)) {
    console.log(`[git-q-release] ${tagName} already exists; tag push skipped.`);
    return;
  }

  runGit(['tag', tagName], { cwd: repoRoot, stdio: 'inherit' });
  runGit(['push', 'origin', tagName], { cwd: repoRoot, stdio: 'inherit' });
  console.log(`[git-q-release] pushed ${tagName}`);
}

function main() {
  const message = process.argv.slice(2).join(' ').trim() || 'wip';
  const dirtyBeforeBump = hasChanges();
  const currentVersion = getCurrentVersion();

  if (!dirtyBeforeBump) {
    createAndPushTag(currentVersion);
    return;
  }

  const nextVersion = findNextPatchVersion(currentVersion);
  bumpPackageVersion(nextVersion);
  runGit(['add', '-A'], { cwd: repoRoot, stdio: 'inherit' });
  runGit(['commit', '-m', message], { cwd: repoRoot, stdio: 'inherit' });
  runGit(['push'], { cwd: repoRoot, stdio: 'inherit' });
  createAndPushTag(nextVersion);
}

try {
  main();
} catch (error) {
  console.error(`[git-q-release] ${error.message || error}`);
  process.exit(1);
}
