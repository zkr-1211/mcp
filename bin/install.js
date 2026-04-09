#!/usr/bin/env node
import { platform, arch } from 'os';
import { createWriteStream, chmodSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 下载源配置（gh-proxy.com 优先，镜像备用）
const GITHUB_REPO = 'zkr-1211/mcp';
const GITHUB_BASE_URL = `https://github.com/${GITHUB_REPO}/releases/download`;
const MIRROR_URLS = [
  `https://gh-proxy.com/https://github.com/${GITHUB_REPO}/releases/download`,
  `https://mirror.ghproxy.com/https://github.com/${GITHUB_REPO}/releases/download`,
];

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
const githubUrl = `${GITHUB_BASE_URL}/v${version}/${binaryName}`;

const releaseDir = join(__dirname, '..', 'release');
const destPath = join(releaseDir, binaryName);

if (existsSync(destPath)) {
  console.log(`[postar-pipe-mcp] Binary already exists: ${binaryName}`);
  process.exit(0);
}

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

console.log(`[postar-pipe-mcp] Downloading ${binaryName}...`);

// 尝试多个下载源
const downloadUrls = [
  ...MIRROR_URLS.map(m => `${m}/v${version}/${binaryName}`),
  githubUrl,
];

let currentUrlIndex = 0;

function tryDownload() {
  if (currentUrlIndex >= downloadUrls.length) {
    console.error('[postar-pipe-mcp] All download sources failed');
    console.error(`[postar-pipe-mcp] You can manually download from: ${githubUrl}`);
    process.exit(0);
  }

  const url = downloadUrls[currentUrlIndex];
  console.log(`[postar-pipe-mcp] Attempt ${currentUrlIndex + 1}/${downloadUrls.length}: ${url}`);
  download(url, destPath);
  currentUrlIndex++;
}

tryDownload();

function download(url, dest, redirectCount = 0) {
  if (redirectCount > 5) {
    console.error('[postar-pipe-mcp] Too many redirects');
    tryDownload();
    return;
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
      tryDownload();
      return;
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
        
        // 修复 npx 执行权限问题
        fixBinPermissions();
      });
    });
  }).on('error', (err) => {
    file.close();
    console.error(`[postar-pipe-mcp] Download error: ${err.message}`);
    tryDownload();
  });
}

// 修复 bin 文件执行权限（npm publish 会丢失权限）
function fixBinPermissions() {
  if (isWindows) return;
  
  const binPath = join(__dirname, 'postar-pipe-mcp.js');
  const distPath = join(__dirname, '..', 'dist', 'server.js');
  
  try {
    if (existsSync(binPath)) {
      chmodSync(binPath, 0o755);
      console.log('[postar-pipe-mcp] Fixed bin/postar-pipe-mcp.js permissions');
    }
    if (existsSync(distPath)) {
      chmodSync(distPath, 0o755);
      console.log('[postar-pipe-mcp] Fixed dist/server.js permissions');
    }
  } catch (err) {
    console.error(`[postar-pipe-mcp] Failed to fix permissions: ${err.message}`);
  }
}
