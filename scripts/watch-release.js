#!/usr/bin/env node
/**
 * 监听 GitHub Release 构建完成，自动触发上传 OSS
 * 用法: node scripts/watch-release.js
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RELEASE_FILES, GITHUB_REPO } from './config.js';
import { config as loadEnv } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载 .env 文件
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  loadEnv({ path: envPath });
  console.error('[Config] Loaded .env file');
}

const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;

const pkgJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const version = pkgJson.version;
const tagName = `v${version}`;

// 轮询配置
const POLL_INTERVAL = 15000; // 15 秒（避免触发 GitHub API 速率限制）
const MAX_POLL_TIME = 30 * 60 * 1000; // 30 分钟超时（构建可能需要较长时间）

console.log(`👀 开始监听 GitHub Release: ${tagName}`);
console.log(`   轮询间隔: ${POLL_INTERVAL / 1000}秒`);
console.log(`   超时时间: ${MAX_POLL_TIME / 60000}分钟\n`);

const startTime = Date.now();
let lastStatus = '';
let firstWorkflowFound = false; // 标记是否找到了新的 workflow

/**
 * 获取 Release 信息
 */
async function getRelease() {
  try {
    const response = await fetch(`${GITHUB_API}/releases/tags/${tagName}`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        // 支持多种环境变量名
        ...(process.env.GITHUB_TOKEN && { 'Authorization': `token ${process.env.GITHUB_TOKEN}` })
      },
    });

    if (response.status === 404) {
      return null; // Release 还未创建
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`⚠️  获取 Release 失败: ${error.message}`);
    return null;
  }
}

/**
 * 获取最新 workflow 运行状态
 */
async function getLatestWorkflowRun() {
  try {
    const response = await fetch(
      `${GITHUB_API}/actions/runs?event=push&per_page=5`,
      {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          // 支持多种环境变量名
          ...(process.env.GITHUB_TOKEN && { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }),
          ...(process.env.GitHub_token && { 'Authorization': `token ${process.env.GitHub_token}` }),
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.workflow_runs && data.workflow_runs.length > 0) {
      // 优先匹配当前版本号（精确匹配）
      const matchingWorkflow = data.workflow_runs.find(run => 
        run.head_branch === version || // 1.4.2
        run.head_branch === tagName ||  // v1.4.2
        run.head_branch === `refs/tags/${tagName}` // refs/tags/v1.4.2
      );
      
      if (matchingWorkflow) {
        firstWorkflowFound = true;
        console.log(`   ↳ 找到匹配的 workflow: ${matchingWorkflow.head_branch} (${matchingWorkflow.status})`);
        return matchingWorkflow;
      }
      
      // 如果还没找到新的 workflow，且第一条是 completed 状态，说明是旧的
      const latest = data.workflow_runs[0];
      if (!firstWorkflowFound && latest.status === 'completed') {
        return null; // 返回 null，继续等待新的 workflow
      }
      
      return latest;
    }
    return null;
  } catch (error) {
    console.error(`⚠️  获取 workflow 状态失败: ${error.message}`);
    return null;
  }
}

/**
 * 触发本地上传 OSS
 */
function triggerUpload() {
  console.log('\n✅ GitHub Release 构建完成！');
  console.log('🚀 开始上传到 OSS...\n');

  try {
    execSync('node scripts/download-from-github.js', {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
    });

    console.log('\n🎉 全部完成！');
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ 上传 OSS 失败: ${error.message}`);
    process.exit(1);
  }
}

/**
 * 主轮询逻辑
 */
async function poll() {
  const elapsed = Date.now() - startTime;

  // 检查超时
  if (elapsed > MAX_POLL_TIME) {
    console.error('\n❌ 轮询超时，停止监听');
    console.error(`   已等待: ${Math.floor(elapsed / 60000)}分钟`);
    process.exit(1);
  }

  // 显示等待时间
  const elapsedSec = Math.floor(elapsed / 1000);
  const remainingSec = Math.floor((MAX_POLL_TIME - elapsed) / 1000);
  
  // 格式化时间显示
  const formatTime = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}分${secs}秒` : `${mins}分钟`;
  };

  try {
    // 1. 检查最新 workflow 状态
    const workflow = await getLatestWorkflowRun();

    if (!workflow) {
      const status = '⏳ 等待 workflow 启动...';
      if (status !== lastStatus) {
        console.log(status);
        lastStatus = status;
      } else {
        process.stdout.write(`\r⏳ 等待 workflow 启动... (已等待 ${formatTime(elapsedSec)} / 剩余 ${formatTime(remainingSec)})`);
      }
      setTimeout(poll, POLL_INTERVAL);
      return;
    }

    // 显示 workflow 状态
    const statusMap = {
      'queued': '🔵 排队中',
      'in_progress': '🟡 构建中',
      'completed': '✅ 已完成',
      'failure': '❌ 失败',
      'cancelled': '⛔ 已取消',
    };

    const statusText = statusMap[workflow.status] || workflow.status;
    const conclusionText = workflow.conclusion ? ` (${workflow.conclusion})` : '';
    const status = `${statusText}${conclusionText} - ${workflow.name || 'Build'}`;

    if (status !== lastStatus) {
      console.log(`\n${status}`);
      lastStatus = status;
    } else {
      process.stdout.write(`\r${status} (已等待 ${formatTime(elapsedSec)} / 剩余 ${formatTime(remainingSec)})`);
    }

    // 2. 判断 workflow 状态
    if (workflow.status === 'queued' || workflow.status === 'in_progress') {
      // 还在运行中，继续等待
      setTimeout(poll, POLL_INTERVAL);
      return;
    }

    if (workflow.status === 'completed' && workflow.conclusion === 'success') {
      // 构建成功，检查 Release 文件
      console.log('\n\n✅ Workflow 构建成功！');
      console.log('🔍 检查 Release 文件...');

      const release = await getRelease();
      if (!release) {
        console.error('⚠️  Release 尚未创建，等待中...');
        setTimeout(poll, POLL_INTERVAL);
        return;
      }

      // 检查 Release 是否包含所需的文件（从共享配置读取）
      const assets = release.assets || [];
      const requiredFiles = RELEASE_FILES;

      const missingFiles = requiredFiles.filter(
        file => !assets.some(asset => asset.name === file)
      );

      if (missingFiles.length > 0) {
        console.error(`⚠️  Release 文件不完整，缺少: ${missingFiles.join(', ')}`);
        setTimeout(poll, POLL_INTERVAL);
        return;
      }

      // 所有检查通过，触发上传
      triggerUpload();
      return;
    }

    // workflow 失败或取消
    if (workflow.status === 'completed' && workflow.conclusion !== 'success') {
      console.error(`\n\n❌ Workflow ${workflow.conclusion || '失败'}`);
      console.error(`   查看日志: ${workflow.html_url}`);
      process.exit(1);
    }

    // 其他状态，继续等待
    setTimeout(poll, POLL_INTERVAL);
  } catch (error) {
    console.error(`\n⚠️  轮询异常: ${error.message}`);
    setTimeout(poll, POLL_INTERVAL);
  }
}

// 开始轮询
poll();
