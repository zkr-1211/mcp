/**
 * MCP 客户端注册
 */
import { getMCPClientManager } from './mcp-client.js';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

interface JenkinsInstance {
  name: string;
  url: string;
  user: string;
  token: string;
}

/**
 * 解析所有 Jenkins 实例配置
 * 支持格式：
 * - 默认实例：JENKINS_URL, JENKINS_USER, JENKINS_TOKEN
 * - 命名实例：JENKINS_{NAME}_URL, JENKINS_{NAME}_USER, JENKINS_{NAME}_TOKEN
 */
function parseJenkinsInstances(): JenkinsInstance[] {
  const instances: JenkinsInstance[] = [];

  // 1. 检测默认 Jenkins 配置（无后缀）
  const defaultUrl = process.env.JENKINS_URL;
  const defaultUser = process.env.JENKINS_USER;
  const defaultToken = process.env.JENKINS_TOKEN;

  if (defaultUrl && defaultUser && defaultToken) {
    instances.push({
      name: 'jenkins',
      url: defaultUrl,
      user: defaultUser,
      token: defaultToken,
    });
  }

  // 2. 检测命名 Jenkins 实例
  // 找出所有符合 JENKINS_*_URL 格式的环境变量
  const urlPattern = /^JENKINS_([A-Z0-9_]+)_URL$/;

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(urlPattern);
    if (!match || !value) continue;

    const suffix = match[1];
    const userKey = `JENKINS_${suffix}_USER`;
    const tokenKey = `JENKINS_${suffix}_TOKEN`;

    const user = process.env[userKey];
    const token = process.env[tokenKey];

    if (user && token) {
      // 将后缀转换为小写，下划线替换为连字符
      // 例如：JENKINS_PROD_UAT_URL -> jenkins-prod-uat
      const instanceName = `jenkins-${suffix.toLowerCase().replace(/_/g, '-')}`;

      instances.push({
        name: instanceName,
        url: value,
        user,
        token,
      });
    }
  }

  return instances;
}

/**
 * 获取包的入口文件路径
 */
function getPackageEntry(packageName: string): string | null {
  try {
    const pkgPath = require.resolve(`${packageName}/package.json`);
    const pkg = require(pkgPath);
    const bin = pkg.bin;
    const binPath = typeof bin === 'string' ? bin : Object.values(bin)[0];
    return join(dirname(pkgPath), binPath as string);
  } catch (error) {
    console.error(`[MCP-PIPE] 无法找到 ${packageName}:`, error);
    return null;
  }
}

/**
 * 注册 GitLab MCP
 */
function registerGitLab(manager: ReturnType<typeof getMCPClientManager>): void {
  const gitlabToken = process.env.GITLAB_TOKEN;
  const gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.com';

  if (gitlabToken) {
    const nodePath = process.execPath;
    const gitlabPath = getPackageEntry('gitlab-core-mcp');

    if (!gitlabPath) {
      console.error('[MCP-PIPE] 警告：gitlab-core-mcp 未安装，GitLab 功能不可用');
      return;
    }

    manager.registerConfig('gitlab', {
      name: 'gitlab',
      command: nodePath,
      args: [gitlabPath],
      env: {
        GITLAB_API_URL: gitlabUrl,
        GITLAB_TOKEN: gitlabToken,
      },
    });
    console.error('[MCP-PIPE] GitLab MCP 已注册');
  } else {
    console.error('[MCP-PIPE] 警告：GITLAB_TOKEN 未设置，GitLab 功能不可用');
  }
}

/**
 * 注册 Jenkins MCP 实例
 */
function registerJenkinsInstances(manager: ReturnType<typeof getMCPClientManager>): void {
  const instances = parseJenkinsInstances();

  if (instances.length === 0) {
    console.error('[MCP-PIPE] 警告：未检测到任何 Jenkins 配置');
    return;
  }

  const nodePath = process.execPath;
  const jenkinsPath = getPackageEntry('jenkins-mcp');

  if (!jenkinsPath) {
    console.error('[MCP-PIPE] 警告：jenkins-mcp 未安装，Jenkins 功能不可用');
    return;
  }

  for (const instance of instances) {
    manager.registerConfig(instance.name, {
      name: instance.name,
      command: nodePath,
      args: [
        jenkinsPath,
        '--jenkins-url',
        instance.url,
        '--jenkins-username',
        instance.user,
        '--jenkins-password',
        instance.token,
      ],
    });
    console.error(`[MCP-PIPE] ${instance.name} MCP 已注册 (${instance.url})`);
  }
}

/**
 * 初始化所有 MCP 客户端
 */
export function initMCPClients(): void {
  const manager = getMCPClientManager();

  registerGitLab(manager);
  registerJenkinsInstances(manager);
}
