/**
 * Word to Markdown MCP 工具封装
 * 将 Word 文档转换功能暴露给 MCP Server
 */

import { convertWordToMd } from '../scripts/word-to-md.js';
import { z } from 'zod';
import { join, extname, basename, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// 获取项目根目录(与 converter.ts 保持一致)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');

// 检测是否在 pkg 打包环境中(与 converter.ts 保持一致)
const isPkg = process.execPath.includes('/snapshot/') || process.execPath.includes('\\snapshot\\') || typeof (process as any).pkg !== 'undefined';

/**
 * Word 转 Markdown 工具配置
 */
export const wordToMdTool = {
  name: 'word-to-md',
  description: '将 Word 文档(.docx)转换为 Markdown 格式。支持按标题层级拆分、模块过滤、图片提取。',
  inputSchema: {
    inputPath: z.string().describe('Word 文档的绝对路径(.docx 格式)'),
    outputDir: z.string().optional().describe('输出目录的绝对路径(可选,默认使用当前工作目录下的 docs/md/)'),
    splitLevel: z.number().optional().describe('按标题级别拆分(例如:2 表示按 ## 拆分),0 表示不拆分'),
    modules: z.string().optional().describe('只输出指定模块,逗号分隔(例如:"5.1,5.2")'),
    imagesInModule: z.boolean().optional().describe('将图片放在各模块文件夹内,而非全局 assets/ 目录'),
  },
  handler: async ({ 
    inputPath, 
    outputDir,
    splitLevel = 0, 
    modules, 
    imagesInModule = false 
  }: { 
    inputPath: string; 
    outputDir?: string;
    splitLevel?: number; 
    modules?: string; 
    imagesInModule?: boolean;
  }) => {
    try {
      // 解析 modules 参数
      const modulesArray = modules 
        ? modules.split(',').map(m => m.trim())
        : null;

      // 调用转换函数,传入自定义输出目录(如果有)
      await convertWordToMd(inputPath, {
        splitLevel,
        modules: modulesArray,
        imagesInModule,
        outputDir,
      });

      // 计算输出路径(如果未指定则使用默认逻辑)
      const fileExtension = extname(inputPath).toLowerCase();
      const fullFileName = basename(inputPath, fileExtension);
      const match = fullFileName.match(/^(\d+)/);
      const folderName = match ? match[1] : fullFileName;
      
      // 计算输出路径:从输入文件路径推导项目目录(查找最近的 .git 或 package.json)
      let actualOutputDir: string;
      if (outputDir) {
        actualOutputDir = outputDir;
      } else {
        const fs = await import('fs-extra');
        const inputFileDir = dirname(inputPath);
        let projectDir = inputFileDir;
        
        // 向上最多查找5级目录
        for (let i = 0; i < 5; i++) {
          const hasGit = fs.default.existsSync(join(projectDir, '.git'));
          const hasPackageJson = fs.default.existsSync(join(projectDir, 'package.json'));
          
          if (hasGit || hasPackageJson) {
            break;
          }
          
          const parentDir = dirname(projectDir);
          if (parentDir === projectDir) break;
          projectDir = parentDir;
        }
        
        actualOutputDir = join(projectDir, 'docs', 'md', folderName);
      }

      return {
        content: [{
          type: 'text' as const,
          text: `✅ Word 文档转换成功!\n\n` +
                `📁 输出目录: \`${actualOutputDir}\`\n\n` +
                `📋 转换参数:\n` +
                `- 拆分级别: ${splitLevel > 0 ? `H${splitLevel}` : '不拆分'}\n` +
                `- 模块过滤: ${modulesArray ? modulesArray.join(', ') : '无'}\n` +
                `- 图片位置: ${imagesInModule ? '各模块内' : '全局 assets/'}\n\n` +
                `💡 提示: 转换后的文件已保存到输出目录,包含 index.md(目录索引)和 summary.json(摘要信息)`,
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text' as const,
          text: `❌ 转换失败: ${error.message || error}\n\n` +
                `💡 请检查:\n` +
                `1. 文件路径是否正确（必须是 .docx 格式）\n` +
                `2. 文件是否存在且可访问`,
        }],
        isError: true,
      };
    }
  },
};
