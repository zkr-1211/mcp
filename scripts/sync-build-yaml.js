#!/usr/bin/env node
/**
 * 从 config.js 同步更新 build.yml
 * 用法: node scripts/sync-build-yaml.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { BUILD_TARGETS } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 平台到 GitHub Runner 的映射
const runnerMap = {
  'macos': 'macos-latest',
  'win': 'windows-latest',
  'linux': 'ubuntu-latest',
};

// 读取 build.yml
const ymlPath = join(__dirname, '..', '.github', 'workflows', 'build.yml');
const ymlContent = readFileSync(ymlPath, 'utf-8');
const yml = yaml.load(ymlContent);

// 生成新的 matrix.include
const matrixInclude = BUILD_TARGETS.map(t => ({
  os: runnerMap[t.platform] || `${t.platform}-latest`,
  target: t.pkgTarget,
  output: `postar-pipe-mcp-${t.platform}-${t.arch}${t.platform === 'win' ? '.exe' : ''}`,
}));

// 更新 matrix
yml.jobs.build.strategy.matrix.include = matrixInclude;

// 生成打包脚本
const packageSteps = BUILD_TARGETS.map(t => {
  const name = `postar-pipe-mcp-${t.platform}-${t.arch}${t.platform === 'win' ? '.exe' : ''}`;
  const zipName = name.replace(/\.exe$/, '');
  const isWindows = t.platform === 'win';
  
  const lines = [
    `          # ${t.platform.toUpperCase()} ${t.arch.toUpperCase()}`,
    `          if [ -f ${name} ]; then`,
  ];
  
  if (!isWindows) {
    lines.push(`            chmod +x ${name}`);
  }
  
  lines.push(`            zip ${zipName}.zip ${name}`);
  lines.push(`          fi`);
  
  return lines.join('\n');
}).join('\n');

// 直接生成完整的 run 脚本内容
const packageScript = `cd release
${packageSteps.replace(/^          /gm, '')}
ls -la`;

// 更新 release job 的打包步骤
if (yml.jobs.release && yml.jobs.release.steps) {
  const packageStepIndex = yml.jobs.release.steps.findIndex(
    s => s.name === 'Package binaries with permissions'
  );
  
  if (packageStepIndex !== -1) {
    yml.jobs.release.steps[packageStepIndex].run = packageScript;
  }
}

// 写回 - 手动修复多行字符串
let newYml = yaml.dump(yml, { 
  indent: 2, 
  lineWidth: -1, 
  noRefs: true,
});

// 替换错误的缩进
newYml = newYml.split('\n').map(line => {
  // 20空格 -> 10空格 (第一层)
  if (line.startsWith('                    ')) {
    return '          ' + line.trim();
  }
  // 22空格 -> 12空格 (if 内部)
  if (line.startsWith('                      ')) {
    return '            ' + line.trim();
  }
  return line;
}).join('\n');

// 去除 run: |- 中的 -
newYml = newYml.replace(/run: \|-/g, 'run: |');

writeFileSync(ymlPath, newYml, 'utf-8');

console.log('✅ build.yml 已更新:');
matrixInclude.forEach(m => console.log(`   ${m.os} -> ${m.target}`));
