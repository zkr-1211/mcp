/**
 * MCP 工具代理
 */
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getMCPClientManager } from './mcp-client.js';
import { parseGitLabUrl, buildGitLabHeaders } from './gitlab-utils.js';

// 固定的 GitLab 前缀
const GITLAB_PREFIX = 'mcp_gitlab_';

/**
 * 简单的 YAML 解析器（只支持我们需要的配置格式）
 * 避免 pkg 打包后的 js-yaml 动态 import 问题
 */
function parseSimpleYaml(content: string): MCPToolsConfig {
  const config: MCPToolsConfig = {};
  const lines = content.split('\n');
  let currentSection: string | null = null;
  let currentArray: string | null = null;

  for (const line of lines) {
    // 去掉行内注释
    let cleanLine = line;
    const commentIndex = line.indexOf('#');
    if (commentIndex > 0) {
      cleanLine = line.substring(0, commentIndex);
    }
    
    const trimmed = cleanLine.trim();
    
    // 跳过空行
    if (!trimmed) continue;

    // 检测顶级配置 (gitlab:, jenkins:, jenkins-prod:)
    const sectionMatch = trimmed.match(/^(gitlab|jenkins(?:-[a-z0-9-]+)?):$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      config[currentSection] = {};
      currentArray = null;
      continue;
    }

    // 检测数组项 (- item)
    if (currentSection && trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim();
      if (item && currentArray && config[currentSection]) {
        if (!config[currentSection][currentArray]) {
          config[currentSection][currentArray] = [];
        }
        config[currentSection][currentArray].push(item);
      }
      continue;
    }

    // 检测数组键 (enabled:, disabled:)
    if (currentSection && (trimmed === 'enabled:' || trimmed === 'disabled:')) {
      currentArray = trimmed.slice(0, -1); // 去掉冒号
      if (!config[currentSection][currentArray]) {
        config[currentSection][currentArray] = [];
      }
      continue;
    }
  }

  return config;
}

/**
 * MCP 工具配置接口
 */
interface MCPToolsConfig {
  gitlab?: {
    enabled?: string[];    // 白名单
    disabled?: string[];   // 黑名单
  };
  jenkins?: {
    enabled?: string[];
    disabled?: string[];
  };
  [key: string]: any;  // 支持其他自定义配置
}

/**
 * 从 GitLab 远程加载工具配置
 * 支持两种 URL 格式:
 * 1. GitLab API 格式: http://host/api/v4/projects/{path}/repository/files/{file}/raw?ref={ref}
 * 2. Web URL 格式: http://host/namespace/project/raw/ref/path/to/file (自动转换为 API)
 */
async function fetchRemoteToolsConfig(configUrl: string): Promise<MCPToolsConfig | null> {
  try {
    console.error(`[MCP-PIPE] 从远程加载工具配置: ${configUrl}`);

    let apiUrl = configUrl;

    // 如果是 Web URL，转换为 GitLab API
    if (!configUrl.includes('/api/v4/')) {
      console.error(`[MCP-PIPE] 解析 Web URL: ${configUrl}`);
      
      const parsed = await parseGitLabUrl(configUrl, 'raw');
      if (!parsed) {
        throw new Error('无法解析 URL 格式，请使用 GitLab Raw URL');
      }
      
      const { host, projectPath, ref, path: filePath } = parsed;
      const encodedProjectPath = encodeURIComponent(projectPath);
      apiUrl = `${host}/api/v4/projects/${encodedProjectPath}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
      console.error(`[MCP-PIPE] 转换为 GitLab API: ${apiUrl}`);
    }

    // 构建请求头
    const headers = buildGitLabHeaders({
      'Accept': 'text/yaml, text/plain, */*',
    });

    if (process.env.GITLAB_TOKEN) {
      console.error(`[MCP-PIPE] 使用 GitLab Token 认证`);
    } else {
      console.error(`[MCP-PIPE] 警告: 未配置 GITLAB_TOKEN，可能无法访问私有仓库`);
    }

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText.substring(0, 200)}`);
    }

    const content = await response.text();

    // 检查是否返回了 HTML 页面
    if (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html')) {
      throw new Error('返回了 HTML 页面，请检查 URL 是否正确或 GITLAB_TOKEN 是否有效');
    }

    // 简单解析 YAML（避免 pkg 打包后的动态 import 问题）
    const config = parseSimpleYaml(content);

    console.error(`[MCP-PIPE] 远程工具配置加载成功`);
    return config;
  } catch (error: any) {
    console.error(`[MCP-PIPE] 远程工具配置加载失败: ${error.message}`);
    return null;
  }
}

/**
 * 获取工具配置（支持远程 + 本地覆盖）
 * 优先级：远程配置 > 本地环境变量 > 默认（全部启用）
 * 注意：不缓存，每次启动都重新拉取
 */
async function getToolsConfig(): Promise<MCPToolsConfig> {
  let config: MCPToolsConfig = {};

  // 1. 尝试从远程加载
  const remoteConfigUrl = process.env.MCP_TOOLS_CONFIG_URL || 'http://192.168.162.164:9081/zhangkr/ai-test/raw/master/postar-pipe-mcp/mcp-tools-config.yaml';
  if (remoteConfigUrl) {
    console.error(`[MCP-PIPE] 📡 尝试从远程加载配置: ${remoteConfigUrl}`);
    const remoteConfig = await fetchRemoteToolsConfig(remoteConfigUrl);
    if (remoteConfig) {
      config = remoteConfig;
      console.error(`[MCP-PIPE] ✅ 使用远程工具配置`);
      console.error(`[MCP-PIPE]    GitLab 启用: ${config.gitlab?.enabled?.length || 0} 个`);
      console.error(`[MCP-PIPE]    GitLab 禁用: ${config.gitlab?.disabled?.length || 0} 个`);
      console.error(`[MCP-PIPE]    Jenkins 启用: ${config.jenkins?.enabled?.length || 0} 个`);
      console.error(`[MCP-PIPE]    Jenkins 禁用: ${config.jenkins?.disabled?.length || 0} 个`);
    } else {
      console.error(`[MCP-PIPE] ⚠️  远程配置加载失败，使用默认配置（全部启用）`);
    }
  } else {
    console.error(`[MCP-PIPE] ⚠️  未配置 MCP_TOOLS_CONFIG_URL，使用默认配置`);
  }

  // 2. 本地环境变量覆盖（优先级更高）
  const gitlabTools = process.env.GITLAB_TOOLS;
  if (gitlabTools) {
    config.gitlab = {
      ...config.gitlab,
      enabled: gitlabTools.split(',').map(s => s.trim()).filter(s => s),
    };
    console.error(`[MCP-PIPE] 使用环境变量覆盖 GitLab 工具: ${gitlabTools}`);
  }

  const jenkinsTools = process.env.JENKINS_TOOLS;
  if (jenkinsTools) {
    config.jenkins = {
      ...config.jenkins,
      enabled: jenkinsTools.split(',').map(s => s.trim()).filter(s => s),
    };
    console.error(`[MCP-PIPE] 使用环境变量覆盖 Jenkins 工具: ${jenkinsTools}`);
  }

  return config;
}

/**
 * 检查工具是否应该启用
 */
function isToolEnabled(serverName: string, toolName: string, config: MCPToolsConfig): boolean {
  // 获取服务器对应的配置键
  const configKey = serverName.startsWith('jenkins') ? 'jenkins' : serverName;
  const serverConfig = config[configKey];

  if (!serverConfig) {
    return true; // 没有配置，默认启用
  }

  // 检查黑名单
  if (serverConfig.disabled && serverConfig.disabled.includes(toolName)) {
    return false;
  }

  // 检查白名单
  if (serverConfig.enabled && serverConfig.enabled.length > 0) {
    return serverConfig.enabled.includes(toolName);
  }

  return true;
}

/**
 * 获取所有已注册的 MCP 服务器名称
 * 与 mcp-registry.ts 中的注册逻辑保持一致
 */
function getRegisteredServers(): string[] {
  const servers: string[] = [];

  // 1. 只在 GITLAB_TOKEN 存在时才添加 gitlab
  if (process.env.GITLAB_TOKEN) {
    servers.push('gitlab');
    console.error('[MCP-PIPE][DEBUG] 检测到 GITLAB_TOKEN,添加 gitlab 服务器');
  } else {
    console.error('[MCP-PIPE][DEBUG] 未检测到 GITLAB_TOKEN');
  }

  // 2. 检测默认 Jenkins 配置（无后缀）
  if (process.env.JENKINS_URL && process.env.JENKINS_USER && process.env.JENKINS_TOKEN) {
    servers.push('jenkins');
    console.error('[MCP-PIPE][DEBUG] 检测到默认 Jenkins 配置');
  } else {
    console.error('[MCP-PIPE][DEBUG] 未检测到默认 Jenkins 配置 (JENKINS_URL/JENKINS_USER/JENKINS_TOKEN)');
  }

  // 3. 检测命名 Jenkins 实例
  // 规则：JENKINS_{NAME}_URL 格式的环境变量对应 jenkins-{name} 实例
  const urlPattern = /^JENKINS_([A-Z0-9_]+)_URL$/;
  console.error('[MCP-PIPE][DEBUG] 开始检测命名 Jenkins 实例...');

  for (const key of Object.keys(process.env)) {
    const match = key.match(urlPattern);
    if (!match) continue;

    const suffix = match[1];
    const userKey = `JENKINS_${suffix}_USER`;
    const tokenKey = `JENKINS_${suffix}_TOKEN`;

    const user = process.env[userKey];
    const token = process.env[tokenKey];

    console.error(`[MCP-PIPE][DEBUG] 检查 ${key} -> suffix=${suffix}, user=${!!user}, token=${!!token}`);

    if (user && token) {
      // 将后缀转换为小写，下划线替换为连字符
      // 例如：JENKINS_PROD_URL -> jenkins-prod
      const instanceName = `jenkins-${suffix.toLowerCase().replace(/_/g, '-')}`;
      servers.push(instanceName);
      console.error(`[MCP-PIPE][DEBUG] ✅ 添加命名 Jenkins 实例: ${instanceName}`);
    }
  }

  console.error(`[MCP-PIPE][DEBUG] 最终注册的服务器列表: ${servers.join(', ') || '(空)'}`);

  return servers;
}

/**
 * 获取服务器对应的工具前缀
 */
function getToolPrefix(serverName: string): string {
  if (serverName === 'gitlab') {
    return GITLAB_PREFIX;
  }
  // jenkins 或 jenkins-xxx 格式
  if (serverName.startsWith('jenkins-')) {
    const suffix = serverName.slice(8); // 去掉 'jenkins-'
    return `mcp_jenkins_${suffix}_`;
  }
  if (serverName === 'jenkins') {
    return 'mcp_jenkins_';
  }
  return `mcp_${serverName}_`;
}

/**
 * 获取代理的工具列表
 * 优化：Jenkins 实例只获取一次工具列表，为其他实例生成别名
 */
export async function getProxiedTools(): Promise<Tool[]> {
  const manager = getMCPClientManager();
  const allTools: Tool[] = [];
  const servers = getRegisteredServers();

  // 分离 Jenkins 实例和其他 MCP
  const jenkinsServers = servers.filter(s => s.startsWith('jenkins') && s !== 'jenkins');
  const mainJenkins = servers.includes('jenkins') ? 'jenkins' : null;
  const otherServers = servers.filter(s => !s.startsWith('jenkins'));

  // 1. 处理所有 Jenkins 实例（主实例 + 命名实例）
  // 策略：第一个实例直接获取工具列表，后续实例复用工具列表（只改前缀）
  const allJenkinsServers = mainJenkins ? [mainJenkins, ...jenkinsServers] : jenkinsServers;
  let isFirstJenkins = true;

  for (const serverName of allJenkinsServers) {
    const prefix = getToolPrefix(serverName);
    
    // 第一个 Jenkins 实例：直接获取工具列表
    if (isFirstJenkins) {
      try {
        const tools = await manager.listTools(serverName);
        const toolsConfig = await getToolsConfig();
        let enabledCount = 0;
        
        for (const tool of tools.tools || []) {
          // 检查工具是否启用
          if (!isToolEnabled(serverName, tool.name, toolsConfig)) {
            console.error(`[MCP-PIPE] 跳过禁用的工具: ${serverName}/${tool.name}`);
            continue;
          }
          
          const proxiedToolName = `${prefix}${tool.name}`;
          const proxiedTool: Tool = {
            ...tool,
            name: proxiedToolName,
            description: `[${serverName}] ${tool.description || ''}`,
          };
          allTools.push(proxiedTool);
          toolSchemaCache.set(proxiedToolName, tool.inputSchema);
          enabledCount++;
        }
        
        console.error(`[MCP-PIPE] ✅ ${serverName}: 原始 ${tools.tools?.length || 0} 个工具，过滤后保留 ${enabledCount} 个`);
        isFirstJenkins = false;
      } catch (error) {
        console.error(`[MCP-PIPE] 无法从 ${serverName} 获取工具列表:`, error);
        continue;
      }
    } else {
      // 后续实例：复用第一个实例的工具列表，只改前缀
      const sourcePrefix = mainJenkins ? getToolPrefix(mainJenkins) : getToolPrefix(allJenkinsServers[0]);
      const jenkinsTools = allTools.filter(t => t.name.startsWith(sourcePrefix));
      
      for (const tool of jenkinsTools) {
        const originalToolName = tool.name.slice(sourcePrefix.length);
        const proxiedToolName = `${prefix}${originalToolName}`;
        const proxiedTool: Tool = {
          ...tool,
          name: proxiedToolName,
          description: `[${serverName}] ${tool.description || ''}`,
        };
        allTools.push(proxiedTool);
        toolSchemaCache.set(proxiedToolName, tool.inputSchema);
      }
      
      console.error(`[MCP-PIPE] 已为 ${serverName} 生成 ${jenkinsTools.length} 个工具别名`);
    }
  }

  // 3. 处理其他 MCP（如 GitLab）
  for (const serverName of otherServers) {
    const prefix = getToolPrefix(serverName);
    try {
      const tools = await manager.listTools(serverName);
      const toolsConfig = await getToolsConfig();
      let enabledCount = 0;

      for (const tool of tools.tools || []) {
        // 检查工具是否启用
        if (!isToolEnabled(serverName, tool.name, toolsConfig)) {
          console.error(`[MCP-PIPE] 跳过禁用的工具: ${serverName}/${tool.name}`);
          continue;
        }
        
        const proxiedToolName = `${prefix}${tool.name}`;
        const proxiedTool: Tool = {
          ...tool,
          name: proxiedToolName,
          description: `[${serverName}] ${tool.description || ''}`,
        };
        allTools.push(proxiedTool);
        
        // 缓存工具 schema
        toolSchemaCache.set(proxiedToolName, tool.inputSchema);
        enabledCount++;
      }

      console.error(`[MCP-PIPE] ✅ ${serverName}: 原始 ${tools.tools?.length || 0} 个工具，过滤后保留 ${enabledCount} 个`);
    } catch (error) {
      console.error(`[MCP-PIPE] 无法获取 ${serverName} 的工具列表:`, error);
    }
  }

  return allTools;
}

/**
 * 根据工具 schema 动态修复参数类型
 * LLM 框架会将所有参数序列化为字符串,但某些 MCP Server 的 schema 要求数字类型
 * 此函数从工具的 inputSchema 中提取类型定义,自动转换参数
 */
function fixArgumentTypes(args: Record<string, any>, toolSchema?: any): Record<string, any> {
  if (!args || typeof args !== 'object') return args;

  const fixedArgs = { ...args };

  // 必须有 schema 才能做类型转换
  if (!toolSchema?.properties) {
    console.warn(`[MCP-PIPE] 警告: 工具缺少 schema,跳过类型修复`);
    return fixedArgs;
  }

  for (const [key, schema] of Object.entries(toolSchema.properties)) {
    if (key in fixedArgs && typeof fixedArgs[key] === 'string') {
      const propSchema = schema as any;
      
      // 检查是否应该转换为数字
      if (propSchema.type === 'number' || propSchema.type === 'integer') {
        const num = Number(fixedArgs[key]);
        if (!isNaN(num)) {
          fixedArgs[key] = num;
          console.debug(`[MCP-PIPE] 类型转换: ${key} "${fixedArgs[key]}" → ${num} (number)`);
        }
      }
      
      // 检查是否应该转换为布尔值
      if (propSchema.type === 'boolean') {
        const str = fixedArgs[key].toLowerCase();
        if (str === 'true' || str === 'false') {
          fixedArgs[key] = str === 'true';
          console.debug(`[MCP-PIPE] 类型转换: ${key} "${str}" → ${fixedArgs[key]} (boolean)`);
        }
      }
    }
  }

  return fixedArgs;
}

/**
 * 存储工具 schema 的映射表
 */
const toolSchemaCache: Map<string, any> = new Map();

/**
 * 处理代理工具调用
 */
export async function handleProxiedTool(name: string, args: any): Promise<any | null> {
  const manager = getMCPClientManager();
  const servers = getRegisteredServers();

  // 获取工具 schema (用于类型修复)
  const toolSchema = toolSchemaCache.get(name);

  // 修复参数类型
  const fixedArgs = fixArgumentTypes(args, toolSchema);

  // 对于 Jenkins 工具，强制优先使用 jenkins（除非明确指定了其他实例）
  if (name.startsWith('mcp_jenkins_')) {
    // 检查是否是明确指定其他 jenkins 实例的工具名
    // 如: mcp_jenkins_prod_get_item -> 使用 jenkins-prod
    // 如: mcp_jenkins_get_item -> 使用 jenkins
    let targetMCP: string | null = null;
    
    // 先检查是否匹配其他 jenkins 实例（如 jenkins-prod）
    const otherJenkinsServers = servers.filter(s => s.startsWith('jenkins-'));
    for (const serverName of otherJenkinsServers) {
      const prefix = getToolPrefix(serverName);
      if (name.startsWith(prefix)) {
        targetMCP = serverName;
        break;
      }
    }
    
    // 如果没有匹配到其他实例，且工具名是 mcp_jenkins_xxx 格式，使用默认 jenkins
    if (!targetMCP && name.startsWith('mcp_jenkins_') && servers.includes('jenkins')) {
      // 确保不是其他实例的前缀（如 mcp_jenkins_prod_ 已经被上面匹配）
      targetMCP = 'jenkins';
    }
    
    if (targetMCP) {
      const prefix = getToolPrefix(targetMCP);
      const originalToolName = name.slice(prefix.length);
      
      try {
        const result = await manager.callTool(targetMCP, originalToolName, fixedArgs);
        return result;
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `工具调用失败: ${error.message}` }],
          isError: true,
        };
      }
    }
  }

  // GitLab 或其他 MCP 按前缀匹配
  for (const serverName of servers) {
    const prefix = getToolPrefix(serverName);
    if (name.startsWith(prefix)) {
      const originalToolName = name.slice(prefix.length);

      try {
        const result = await manager.callTool(serverName, originalToolName, fixedArgs);
        return result;
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `工具调用失败: ${error.message}` }],
          isError: true,
        };
      }
    }
  }

  return null;
}
