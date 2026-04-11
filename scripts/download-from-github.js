#!/usr/bin/env node
/**
 * 从 GitHub Release 下载二进制文件并自动上传到 OSS
 * 用法: node bin/download-from-github.js
 */

import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import OSS from 'ali-oss';
import { config as loadEnv } from 'dotenv';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载 .env 文件
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  loadEnv({ path: envPath });
  console.log('[Config] Loaded .env file\n');
}

const GITHUB_REPO = 'zkr-1211/mcp';
const GITHUB_BASE_URL = `https://github.com/${GITHUB_REPO}/releases/download`;

const pkgJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const version = pkgJson.version;

// 需要下载的文件列表
const files = [
  'postar-pipe-mcp-macos-arm64.zip',
  'postar-pipe-mcp-win-x64.exe',
];

// ========================================
// OSS 配置（从环境变量读取）
// ========================================
const OSS_CONFIG = {
  region: process.env.OSS_REGION || 'oss-cn-hangzhou',
  accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.OSS_BUCKET || 'vueh5',
  ossPath: process.env.OSS_PATH || 'test/mcp/',
  // 自定义 endpoint（如果有自定义域名）
  endpoint: process.env.OSS_ENDPOINT || null,
};

// 是否需要自动上传到 OSS
const AUTO_UPLOAD_TO_OSS = process.env.AUTO_UPLOAD_TO_OSS !== 'false';  // 默认 true

const releaseDir = join(__dirname, '..', 'release');

// 验证 OSS 配置
if (AUTO_UPLOAD_TO_OSS) {
  if (!OSS_CONFIG.accessKeyId || !OSS_CONFIG.accessKeySecret) {
    console.warn('⚠️  OSS 配置未完成,请在 .env 文件中配置以下变量:');
    console.warn('   OSS_ACCESS_KEY_ID=你的AccessKey ID');
    console.warn('   OSS_ACCESS_KEY_SECRET=你的AccessKey Secret');
    console.warn('   OSS_REGION=oss-cn-hangzhou (可选)');
    console.warn('   OSS_BUCKET=vueh5 (可选)');
    console.warn('   OSS_PATH=test/mcp/ (可选)\n');
  }
}

// 创建 release 目录(如果不存在)
if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

// 清空 release 目录
console.log(`[Clean] Clearing release directory: ${releaseDir}`);
const { readdir, rm } = await import('fs/promises');
const existingFiles = await readdir(releaseDir);
for (const file of existingFiles) {
  const filePath = join(releaseDir, file);
  await rm(filePath, { recursive: true, force: true });
}
console.log(`[✓] Cleared ${existingFiles.length} file(s)\n`);

console.log(`[Download] Downloading binaries from GitHub Release v${version}...\n`);

let completed = 0;
let failed = 0;

files.forEach((filename, index) => {
  const url = `${GITHUB_BASE_URL}/v${version}/${filename}`;
  const destPath = join(releaseDir, filename);
    
  console.log(`[${index + 1}/${files.length}] Downloading ${filename}...`);
    
  downloadWithCurl(url, destPath, filename);
});

function downloadWithCurl(url, dest, filename) {
  try {
    // 使用 curl 下载，-L 跟随重定向，-# 显示进度条
    execSync(`curl -L -# -o "${dest}" "${url}"`, {
      stdio: 'inherit',
      timeout: 300000 // 5分钟超时
    });
    
    // 验证文件大小
    if (!existsSync(dest)) {
      throw new Error('File not created');
    }
    
    const stats = statSync(dest);
    if (stats.size < 1024 * 1024) { // 小于 1MB 认为下载失败
      throw new Error(`File too small: ${(stats.size / 1024).toFixed(2)} KB`);
    }
    
    console.log(`[✓] ${filename} downloaded successfully (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    completed++;
    if (completed + failed === files.length) {
      printSummary();
    }
  } catch (err) {
    console.error(`[✗] ${filename} failed: ${err.message}`);
    failed++;
    if (completed + failed === files.length) {
      printSummary();
    }
  }
}

function printSummary() {
  console.log('\n========================================');
  console.log(`Download complete: ${completed} succeeded, ${failed} failed`);
  console.log(`Files saved to: ${releaseDir}`);
  console.log('========================================');
  
  if (failed > 0) {
    console.error('\n❌ Some files failed to download. Aborting OSS upload.');
    process.exit(1);
  }
  
  // 自动上传到 OSS
  if (AUTO_UPLOAD_TO_OSS && completed === files.length) {
    uploadToOSS();
  } else if (!AUTO_UPLOAD_TO_OSS) {
    console.log('\nNext step: Manually upload to OSS');
    console.log(`oss://${OSS_CONFIG.bucket}/${OSS_CONFIG.ossPath}`);
    console.log('\nFiles to upload:');
    files.forEach(filename => {
      const filePath = join(releaseDir, filename);
      if (existsSync(filePath)) {
        const stats = statSync(filePath);
        const size = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`  ✓ ${filename} (${size} MB)`);
      }
    });
    console.log('');
  }
}

async function uploadToOSS() {
  console.log('\n========================================');
  console.log('Uploading to OSS...');
  console.log('========================================\n');
  
  // 检查 OSS 配置
  if (!OSS_CONFIG.accessKeyId || !OSS_CONFIG.accessKeySecret) {
    console.error('❌ OSS 配置未完成,请在 .env 文件中配置:');
    console.error('');
    console.error('   OSS_ACCESS_KEY_ID=你的AccessKey ID');
    console.error('   OSS_ACCESS_KEY_SECRET=你的AccessKey Secret');
    console.error('');
    console.error('手动上传命令示例:');
    console.log(`  ossutil cp ${releaseDir}/postar-pipe-mcp-macos-arm64.zip oss://vueh5/test/mcp/`);
    console.log(`  ossutil cp ${releaseDir}/postar-pipe-mcp-win-x64.zip oss://vueh5/test/mcp/`);
    console.log(`  ossutil cp ${releaseDir}/postar-pipe-mcp-win-x64.exe oss://vueh5/test/mcp/`);
    process.exit(1);
  }
  
  try {
    // 初始化 OSS 客户端
    const client = new OSS({
      region: OSS_CONFIG.region,
      accessKeyId: OSS_CONFIG.accessKeyId,
      accessKeySecret: OSS_CONFIG.accessKeySecret,
      bucket: OSS_CONFIG.bucket,
      // 使用自定义 endpoint(如果有)
      ...(OSS_CONFIG.endpoint && { endpoint: OSS_CONFIG.endpoint }),
    });
    
    let uploaded = 0;
    let uploadFailed = 0;
    
    // 构建要上传的完整文件列表
    const allFilesToUpload = [...files];
    
    for (const filename of allFilesToUpload) {
      const filePath = join(releaseDir, filename);
      
      if (!existsSync(filePath)) {
        console.error(`[✗] ${filename}: File not found, skipping`);
        uploadFailed++;
        continue;
      }
      
      const ossKey = `${OSS_CONFIG.ossPath}${filename}`;
      const stats = statSync(filePath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      
      try {
        console.log(`[Upload] ${filename} (${sizeMB} MB)...`);
        
        const startTime = Date.now();
        const result = await client.put(ossKey, filePath);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        if (result.res.status === 200) {
          console.log(`[✓] ${filename} uploaded successfully (${duration}s)`);
          console.log(`    URL: https://${OSS_CONFIG.bucket}.${OSS_CONFIG.region}.aliyuncs.com/${ossKey}`);
          uploaded++;
        } else {
          throw new Error(`HTTP ${result.res.status}`);
        }
      } catch (err) {
        console.error(`[✗] ${filename} upload failed: ${err.message}`);
        uploadFailed++;
      }
    }
    
    console.log('\n========================================');
    console.log(`Upload complete: ${uploaded} succeeded, ${uploadFailed} failed`);
    console.log('Uploaded files:');
    allFilesToUpload.forEach(f => {
      if (existsSync(join(releaseDir, f))) {
        const stats = statSync(join(releaseDir, f));
        const size = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`  ✓ ${f} (${size} MB)`);
      }
    });
    console.log('========================================');
    
    if (uploadFailed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n❌ OSS upload failed: ${err.message}`);
    console.error('\n请检查:');
    console.error('  1. AccessKey ID 和 Secret 是否正确');
    console.error('  2. Bucket 是否存在且有写入权限');
    console.error('  3. OSS region 是否正确');
    process.exit(1);
  }
}
