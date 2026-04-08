#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMCPClients } from './utils/mcp-registry.js';
import { getProxiedTools, handleProxiedTool } from './utils/tool-proxy.js';
import { getSkillContent, getAvailableSkills, getSkillMetadata, getAllSkillsMetadata, extractAllSkillResourcesToTempDir, getTempSkillDir, getSkillResourceFiles } from './utils/skill-loader.js';

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
      `${metadata.name}_execute`,
      {
        description: metadata.description,
        inputSchema: {
          trigger: z.string().optional().describe(`触发标识，如 "${metadata.name}"`),
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
          let resourceNotice = `> 📁 **本 Skill 的资源文件**:\n`;
          
          if (resourceFiles.length > 0) {
            for (const file of resourceFiles) {
              resourceNotice += `>   - \`${join(skillResourceDir, file)}\`\n`;
            }
          } else {
            resourceNotice += '>   （无额外资源文件）\n';
          }
          resourceNotice += `> \n> 💡 **提示**: 当 Skill 文档中提到读取配置文件或模板文件时，请使用上述完整路径\n\n`;
          
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

  // 1. 创建固定的 Skill 资源目录
  if (!existsSync(skillResourcesDir)) {
    mkdirSync(skillResourcesDir, { recursive: true });
  }
  console.error(`[MCP-PIPE] Skill 资源目录: ${skillResourcesDir}`);

  // 2. 预加载所有 skills（必须成功才能提供服务）
  await preloadSkills();

  // 3. 将所有 Skill 资源提取到固定目录（初始化时注入）
  await extractAllSkillResourcesToTempDir(skillResourcesDir);

  // 4. 初始化 MCP 客户端
  initMCPClients();

  // 5. 创建并启动 Server
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP-PIPE] Server 已启动');
}

main().catch((error) => {
  console.error('[MCP-PIPE] 致命错误:', error);
  cleanupSkillDir();
  process.exit(1);
});
