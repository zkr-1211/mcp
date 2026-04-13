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

// 更新
yml.jobs.build.strategy.matrix.include = matrixInclude;

// 写回
const newYml = yaml.dump(yml, { indent: 2, lineWidth: -1, noRefs: true });
writeFileSync(ymlPath, newYml, 'utf-8');

console.log('✅ build.yml 已更新:');
matrixInclude.forEach(m => console.log(`   ${m.os} -> ${m.target}`));
