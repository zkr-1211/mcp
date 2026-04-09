#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { platform, arch } from 'os';
import { accessSync, constants } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const platformMap = {
  'darwin': 'macos',
  'linux': 'linux',
  'win32': 'win'
};

const archMap = {
  'arm64': 'arm64',
  'x64': 'x64',
  'ia32': 'x64'  // fallback
};

const currentPlatform = platformMap[platform()] || platform();
const currentArch = archMap[arch()] || 'x64';

// 尝试的顺序：先精确匹配，再尝试其他
const binaryNames = [
  `postar-pipe-mcp-${currentPlatform}-${currentArch}`,
  currentPlatform === 'macos' ? `postar-pipe-mcp-${currentPlatform}-x64` : null,
  'postar-pipe-mcp'  // fallback to default
].filter(Boolean);

const releaseDir = join(__dirname, '..', 'release');

let binaryPath = null;
for (const name of binaryNames) {
  const fullPath = join(releaseDir, name);
  try {
    accessSync(fullPath, constants.X_OK);
    binaryPath = fullPath;
    break;
  } catch {
    continue;
  }
}

if (!binaryPath) {
  console.error(`Error: No binary found for platform ${currentPlatform}-${currentArch}`);
  console.error('Tried:', binaryNames.join(', '));
  process.exit(1);
}

const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
