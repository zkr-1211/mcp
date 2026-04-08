/**
 * MCP 工具代理
 */
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getMCPClientManager } from './mcp-client.js';

// 固定的 GitLab 前缀
const GITLAB_PREFIX = 'mcp_gitlab_';

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
        
        for (const tool of tools.tools || []) {
          const proxiedToolName = `${prefix}${tool.name}`;
          const proxiedTool: Tool = {
            ...tool,
            name: proxiedToolName,
            description: `[${serverName}] ${tool.description || ''}`,
          };
          allTools.push(proxiedTool);
          toolSchemaCache.set(proxiedToolName, tool.inputSchema);
        }
        
        console.error(`[MCP-PIPE] 已从 ${serverName} 获取 ${tools.tools?.length || 0} 个工具`);
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

      for (const tool of tools.tools || []) {
        const proxiedToolName = `${prefix}${tool.name}`;
        const proxiedTool: Tool = {
          ...tool,
          name: proxiedToolName,
          description: `[${serverName}] ${tool.description || ''}`,
        };
        allTools.push(proxiedTool);
        
        // 缓存工具 schema
        toolSchemaCache.set(proxiedToolName, tool.inputSchema);
      }

      console.error(`[MCP-PIPE] 已代理 ${serverName} 的 ${tools.tools?.length || 0} 个工具`);
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
