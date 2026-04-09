#!/usr/bin/env node
import { platform, arch } from 'os';
import { createWriteStream, chmodSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// GitHub 仓库信息（改成你的 owner/repo）
const GITHUB_REPO = 'zkr-1211/mcp';

const pkgJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const version = pkgJson.version;

const platformMap = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'win',
};

const archMap = {
  arm64: 'arm64',
  x64: 'x64',
  ia32: 'x64',
};

const currentPlatform = platformMap[platform()];
const currentArch = archMap[arch()] || 'x64';

if (!currentPlatform) {
  console.error(`[postar-pipe-mcp] Unsupported platform: ${platform()}`);
  process.exit(0); // 不阻断安装
}

const isWindows = platform() === 'win32';
const binaryName = `postar-pipe-mcp-${currentPlatform}-${currentArch}${isWindows ? '.exe' : ''}`;
const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

const releaseDir = join(__dirname, '..', 'release');
const destPath = join(releaseDir, binaryName);

if (existsSync(destPath)) {
  console.log(`[postar-pipe-mcp] Binary already exists: ${binaryName}`);
  process.exit(0);
}

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

console.log(`[postar-pipe-mcp] Downloading ${binaryName} from GitHub Release...`);
console.log(`[postar-pipe-mcp] URL: ${downloadUrl}`);

function download(url, dest, redirectCount = 0) {
  if (redirectCount > 5) {
    console.error('[postar-pipe-mcp] Too many redirects');
    process.exit(1);
  }

  const file = createWriteStream(dest);

  https.get(url, (response) => {
    if (response.statusCode === 301 || response.statusCode === 302) {
      file.close();
      download(response.headers.location, dest, redirectCount + 1);
      return;
    }

    if (response.statusCode !== 200) {
      file.close();
      console.error(`[postar-pipe-mcp] Download failed: HTTP ${response.statusCode}`);
      console.error(`[postar-pipe-mcp] You can manually download from: ${downloadUrl}`);
      process.exit(0); // 不阻断安装，用户可手动处理
    }

    const total = parseInt(response.headers['content-length'] || '0', 10);
    let downloaded = 0;

    response.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) {
        const pct = Math.floor((downloaded / total) * 100);
        process.stdout.write(`\r[postar-pipe-mcp] Progress: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
      }
    });

    response.pipe(file);

    file.on('finish', () => {
      process.stdout.write('\n');
      file.close(() => {
        if (!isWindows) {
          chmodSync(dest, 0o755);
        }
        console.log(`[postar-pipe-mcp] Download complete: ${dest}`);
      });
    });
  }).on('error', (err) => {
    file.close();
    console.error(`[postar-pipe-mcp] Download error: ${err.message}`);
    console.error(`[postar-pipe-mcp] You can manually download from: ${downloadUrl}`);
    process.exit(0); // 不阻断安装
  });
}

download(downloadUrl, destPath);
