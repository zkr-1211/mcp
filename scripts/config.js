/**
 * 共享配置：构建目标和 Release 文件
 * 所有涉及构建、发布、下载的操作都使用此配置
 */

// 构建目标平台配置
export const BUILD_TARGETS = [
  { platform: 'macos', arch: 'arm64', pkgTarget: 'node24-macos-arm64' },
  { platform: 'macos', arch: 'x64', pkgTarget: 'node24-macos-x64' },
  { platform: 'win', arch: 'x64', pkgTarget: 'node24-win-x64' },
  { platform: 'linux', arch: 'x64', pkgTarget: 'node24-linux-x64' },
];

// 根据构建目标生成 Release 文件列表
export const RELEASE_FILES = BUILD_TARGETS.map(target => 
  `postar-pipe-mcp-${target.platform}-${target.arch}.zip`
);

// pkg 构建目标列表
export const PKG_TARGETS = BUILD_TARGETS.map(target => target.pkgTarget);

export const GITHUB_REPO = 'zkr-1211/mcp';

// 验证配置同步（导入时自动执行）
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  const pkgJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
} catch (error) {
  // 忽略验证错误（可能在某些环境下 package.json 不存在）
}
