#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initMCPClients } from './utils/mcp-registry.js';
import { getProxiedTools, handleProxiedTool } from './utils/tool-proxy.js';
import { getSkillContent, getAvailableSkills, getSkillMetadata, getAllSkillsMetadata, extractAllSkillResourcesToTempDir, getTempSkillDir, getSkillResourceFiles } from './utils/skill-loader.js';
import { wordToMdTool } from './utils/word-to-md-tool.js';
import { executeBatch, formatBatchResults } from './utils/batch-executor.js';

// 固定的 Skill 资源目录路径
const FIXED_SKILL_DIR = join(tmpdir(), 'mcp-pipe-skills');
let skillResourcesDir: string = FIXED_SKILL_DIR;

/**
 * 创建并配置 MCP Server
 */
async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: 'mcp-pipe',
    version: '1.0.0',
  });

  // 注册动态 skill 工具
  const skillsMetadata = await getAllSkillsMetadata();
  for (const metadata of skillsMetadata) {
    server.registerTool(
      `${metadata.name}`,
      {
        description: `${metadata.description}`,
        inputSchema: {
          trigger: z.string().optional().describe(`触发标识,如 "${metadata.name}"`),
        },
      },
      async ({ trigger }: { trigger?: string }) => {
        const skills = await getAvailableSkills();
        const effectiveTrigger = trigger || metadata.name;
        const skillLoaded = skills.includes(metadata.name);
        const skillMetadata = await getSkillMetadata(metadata.name);
        const skillContent = await getSkillContent(metadata.name);
        
        // 注入资源文件信息到 Skill 内容中
        let injectedContent = skillContent;
        const currentTempDir = getTempSkillDir();
        if (currentTempDir) {
          const skillResourceDir = join(currentTempDir, metadata.name);
          const resourceFiles = getSkillResourceFiles(metadata.name);
          
          // 在 Skill 内容开头插入资源目录提示（让 AI 第一时间知道去哪找文件）
          let resourceNotice = `> 📁重要必读 **本 Skill 的资源文件、提到的任何文件操作(读取/打开/查看/加载等),都应使用这些提供的路径**:\n`;
          
          if (resourceFiles.length > 0) {
            for (const file of resourceFiles) {
              resourceNotice += `>   - \`${join(skillResourceDir, file)}\`\n`;
            }
          } else {
            resourceNotice += '>   （无额外资源文件）\n';
          }
          resourceNotice += `> \n> 📌 **资源路径说明**: 以上列出的是本 Skill 的所有可用资源文件。\n`;
          resourceNotice += `> 当 Skill 文档中涉及任何文件操作(读取、打开、查看、加载、引用等)时,请使用上述对应的完整路径,不要自行推测或使用其他路径。\n\n`;
          
          injectedContent = resourceNotice + skillContent;
        }
        
        return {
          content: [{
            type: 'text' as const,
            text: `🎯 [${metadata.name.toUpperCase()}_EXECUTE 已触发] 触发词: "${effectiveTrigger}"\n\n📖 ${skillMetadata.description}\n\n${injectedContent}\n\n---\n${skillLoaded ? '✅' : '❌'} Skills 加载状态: ${skillLoaded ? `${metadata.name} skill 已加载` : `${metadata.name} skill 未加载`}\n📦 已加载 Skills (${skills.length} 个): ${skills.join(', ') || '无'}`,
          }],
        };
      }
    );
  }

  // 注册 Word to Markdown 工具
  server.registerTool(
    wordToMdTool.name,
    {
      description: wordToMdTool.description,
      inputSchema: wordToMdTool.inputSchema,
    },
    async (args: any) => {
      return await wordToMdTool.handler(args);
    }
  );

  // 注册批量执行工具
  server.registerTool(
    'batch_execute',
    {
      description: '批量执行多个MCP工具调用，支持组内并行。一次调用完成多步骤操作，减少AI与MCP之间的往返次数。适用于CI/CD流水线、多环境查询、批量操作等场景。',
      inputSchema: {
        steps: z.array(z.object({
          tool: z.string().describe('工具名称'),
          args: z.record(z.any()).optional().describe('工具参数（可选）'),
          parallel_group: z.number().optional().default(0).describe('并行分组编号，同组步骤并发执行，不同组按组号升序顺序执行，默认 0'),
        })).describe('要执行的工具调用列表'),
      },
    },
    async ({ steps }: { steps: Array<{ tool: string; args?: Record<string, any>; parallel_group?: number }> }) => {
      try {
        const results = await executeBatch(steps);
        const formatted = formatBatchResults(results);
        return {
          content: [{ type: 'text' as const, text: formatted }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Batch Execute 执行失败: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // 注册代理工具
  const proxiedTools = await getProxiedTools();
  const JSON_SCHEMA_TYPE_MAP: Record<string, z.ZodTypeAny> = {
    number: z.number(),
    boolean: z.boolean(),
    array: z.array(z.any()),
    object: z.record(z.any()),
  };

  for (const tool of proxiedTools) {
    const inputProps = (tool.inputSchema as any)?.properties || {};
    const required: string[] = (tool.inputSchema as any)?.required || [];
    const shape = Object.fromEntries(
      Object.entries(inputProps).map(([key, val]) => {
        const prop = val as any;
        let zodType = (JSON_SCHEMA_TYPE_MAP[prop.type] ?? z.string()).describe(prop.description ?? '');
        return [key, required.includes(key) ? zodType : zodType.optional()];
      })
    ) as Record<string, z.ZodTypeAny>;
    server.registerTool(
      tool.name,
      {
        description: tool.description || tool.name,
        inputSchema: shape,
      },
      async (args: Record<string, any>) => {
        try {
          const proxyResult = await handleProxiedTool(tool.name, args);
          if (proxyResult) return proxyResult;
          return {
            content: [{ type: 'text' as const, text: `未知工具: ${tool.name}` }],
            isError: true,
          };
        } catch (error: any) {
          return {
            content: [{ type: 'text' as const, text: `执行错误: ${error.message}` }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

/**
 * 预加载所有 skills 到缓存
 */
async function preloadSkills(): Promise<void> {
  const skills = await getAvailableSkills();
  console.error(`[MCP-PIPE] 发现 ${skills.length} 个 skills: ${skills.join(', ')}`);

  for (const skillName of skills) {
    try {
      const content = await getSkillContent(skillName);
      console.error(`[MCP-PIPE] Skill '${skillName}' 已加载 (${content.length} 字符)`);
    } catch (error: any) {
      console.error(`[MCP-PIPE] Skill '${skillName}' 加载失败:`, error.message);
    }
  }
}

/**
 * 清理 Skill 资源目录
 */
function cleanupSkillDir(): void {
  if (existsSync(skillResourcesDir)) {
    try {
      rmSync(skillResourcesDir, { recursive: true, force: true });
      console.error(`[MCP-PIPE] Skill 资源目录已清理: ${skillResourcesDir}`);
    } catch (error) {
      console.error(`[MCP-PIPE] 清理 Skill 资源目录失败: ${skillResourcesDir}`, error);
    }
  }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  // 注册进程退出时的清理钩子
  process.on('exit', cleanupSkillDir);
  process.on('SIGINT', () => {
    console.error('[MCP-PIPE] 收到 SIGINT，正在清理...');
    cleanupSkillDir();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.error('[MCP-PIPE] 收到 SIGTERM，正在清理...');
    cleanupSkillDir();
    process.exit(0);
  });

  // 0. 快速测试 GitLab 连接(5秒超时)
  const gitlabUrl = process.env.GITLAB_URL || 'http://192.168.162.164:9081';
  console.error(`[MCP-PIPE] 测试 GitLab 连接: ${gitlabUrl}`);
  
  let gitlabConnected = false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${gitlabUrl}/api/v4/version`, {
      signal: controller.signal,
      headers: {
        'PRIVATE-TOKEN': process.env.GITLAB_TOKEN || '',
      }
    });
    clearTimeout(timeoutId);
    
    gitlabConnected = response.ok;
  } catch {
    gitlabConnected = false;
  }
  
  if (!gitlabConnected) {
    console.error(`[MCP-PIPE] ⚠️ GitLab 无法连接,使用本地模式 (连上 VPN 后重启即可)`);
    // 设置环境变量,让后续代码跳过远程操作
    process.env.SKILLS_SOURCE = 'local';
    process.env.MCP_TOOLS_SOURCE = 'local';
  } else {
    console.error(`[MCP-PIPE] ✅ GitLab 连接成功`);
  }

  // 1. 创建固定的 Skill 资源目录
  if (!existsSync(skillResourcesDir)) {
    mkdirSync(skillResourcesDir, { recursive: true });
  }
  console.error(`[MCP-PIPE] Skill 资源目录: ${skillResourcesDir}`);

  // 2. 预加载所有 skills（必须成功才能提供服务）
  await preloadSkills();

  // 3. 将所有 Skill 资源提取到固定目录(初始化时注入)
  await extractAllSkillResourcesToTempDir(skillResourcesDir);
  console.error(`[MCP-PIPE] ✅ Skill 资源已提取到: ${skillResourcesDir}`);
  console.error(`[MCP-PIPE] 💡 AI 执行 Skill 时会自动获取资源文件路径`);

  // 4. 初始化 MCP 客户端(会测试连接)
  await initMCPClients();

  // 5. 创建并启动 Server
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP-PIPE] Server 已启动');

  // 6. 输出二进制文件路径（方便一键复制）
  try {
    // 检测是否在 pkg 打包环境中
    const isPkg = typeof (process as any).pkg !== 'undefined';
    let binaryPath: string;
    
    if (isPkg) {
      // pkg 打包环境：使用 process.execPath
      binaryPath = process.execPath;
    } else {
      // 开发环境：根据当前平台动态选择二进制文件名
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const isWindows = process.platform === 'win32';
      const ext = isWindows ? '.exe' : '';
      const binaryName = `postar-pipe-mcp-${isWindows ? 'win-x64' : 'macos-arm64'}${ext}`;
      binaryPath = join(__dirname, '..', 'release', binaryName);
    }
    
    console.error('');
    console.error('═══════════════════════════════════════════════════════');
    console.error('📦 二进制文件路径（已自动复制到剪贴板）:');
    console.error(`   ${binaryPath}`);
    
    // 自动复制到剪贴板
    const currentPlatform = platform();
    if (currentPlatform === 'darwin') {
      // macOS: 使用 pbcopy
      try {
        const { execSync } = await import('child_process');
        // 使用 printf 避免 echo 的转义问题
        execSync(`printf '%s' "${binaryPath}" | pbcopy`);
        console.error('✅ 已复制到剪贴板，可直接粘贴 (Cmd+V)');
      } catch {
        console.error('💡 如未自动复制，请手动选中上方路径');
      }
    } else if (currentPlatform === 'win32') {
      // Windows: 使用 clip
      try {
        const { execSync } = await import('child_process');
        execSync(`echo ${binaryPath} | clip`);
        console.error('✅ 已复制到剪贴板，可直接粘贴 (Ctrl+V)');
      } catch {
        console.error('💡 如未自动复制，请手动选中上方路径');
      }
    } else {
      console.error('💡 路径已显示，请手动复制');
    }
    console.error('═══════════════════════════════════════════════════════');
    console.error('');
  } catch (error) {
    console.error('[MCP-PIPE] 获取二进制路径失败:', error);
  }
}

main().catch((error) => {
  console.error('[MCP-PIPE] 致命错误:', error);
  cleanupSkillDir();
  process.exit(1);
});
