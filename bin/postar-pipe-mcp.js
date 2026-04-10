#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { platform, arch } from 'os';
import { accessSync, constants, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 检测是否在 pkg 打包环境中运行
const isPkgEnvironment = process.argv[0].includes('/snapshot/') || 
                          process.execPath.includes('/snapshot/') ||
                          existsSync('/snapshot');

if (isPkgEnvironment) {
  // 在二进制文件中，直接运行主程序
  const serverPath = join(__dirname, '..', 'dist', 'server.js');
  if (!existsSync(serverPath)) {
    console.error('Error: dist/server.js not found in binary');
    process.exit(1);
  }
  
  // 动态导入并运行
  import(serverPath).catch(err => {
    console.error('Failed to load server:', err);
    process.exit(1);
  });
  // 保持进程运行，等待异步加载
  process.stdin.resume();
}

// npx 安装场景：查找并启动二进制文件
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
const isWindows = platform() === 'win32';
const ext = isWindows ? '.exe' : '';

// 尝试的顺序：先精确匹配，再尝试其他
const binaryNames = [
  `postar-pipe-mcp-${currentPlatform}-${currentArch}${ext}`,
  currentPlatform === 'macos' ? `postar-pipe-mcp-${currentPlatform}-x64` : null,
  `postar-pipe-mcp${ext}`,
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
