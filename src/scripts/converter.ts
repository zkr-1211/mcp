/**
 * Word 文档转换核心逻辑
 * 负责: Word → HTML → Markdown,图片提取
 */

import mammoth from 'mammoth';
import TurndownService from 'turndown';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { splitByHeadingsHierarchical } from './splitter.js';

// 获取项目根目录(不依赖 process.cwd())
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// 检测是否在 pkg 打包环境中(更可靠的方式)
const isPkg = process.execPath.includes('/snapshot/') || process.execPath.includes('\\snapshot\\') || typeof (process as any).pkg !== 'undefined';

export interface ConvertOptions {
  splitLevel?: number;
  modules?: string[] | null;
  imagesInModule?: boolean;
  outputDir?: string; // 自定义输出目录
}

/**
 * 将 Word 文档转换为 Markdown
 */
export async function convertWordToMd(inputPath: string, options: ConvertOptions = {}): Promise<void> {
  const { 
    splitLevel = 0,
    modules = null,
    imagesInModule = false,
    outputDir
  } = options;
  
  try {
    if (!inputPath) {
      throw new Error('Input file path is required.');
    }

    const resolvedInputPath = path.resolve(inputPath);
    const fileExtension = path.extname(resolvedInputPath).toLowerCase();

    if (fileExtension !== '.docx') {
      throw new Error(`Only .docx files are supported. Received: ${fileExtension || 'unknown extension'}`);
    }

    if (!fs.existsSync(resolvedInputPath)) {
      throw new Error(`Input file not found: ${resolvedInputPath}`);
    }

    const fullFileName = path.basename(resolvedInputPath, fileExtension);
    const match = fullFileName.match(/^(\d+)/);
    const folderName = match ? match[1] : fullFileName;

    // 输出目录:从输入文件路径推导项目目录(查找最近的 .git 或 package.json)
    let outputRootDir: string;
    if (outputDir) {
      // 用户指定了输出目录
      outputRootDir = outputDir;
    } else {
      // 从输入文件向上查找项目根目录(有 .git 或 package.json 的目录)
      const inputFileDir = path.dirname(resolvedInputPath);
      let projectDir = inputFileDir;
      
      // 向上最多查找5级目录
      for (let i = 0; i < 5; i++) {
        const hasGit = fs.existsSync(path.join(projectDir, '.git'));
        const hasPackageJson = fs.existsSync(path.join(projectDir, 'package.json'));
        
        if (hasGit || hasPackageJson) {
          console.log(`ℹ️  找到项目根目录: ${projectDir}`);
          break;
        }
        
        const parentDir = path.dirname(projectDir);
        if (parentDir === projectDir) break; // 已到达根目录
        projectDir = parentDir;
      }
      
      outputRootDir = path.join(projectDir, 'docs', 'md', folderName);
    }
    
    // 根据参数决定图片存放位置
    const assetsDir = imagesInModule ? null : path.join(outputRootDir, 'assets');
    if (assetsDir) {
      await fs.ensureDir(assetsDir);
    }

    console.log(`Converting ${resolvedInputPath} to directory: ${outputRootDir}...`);

    await fs.ensureDir(outputRootDir);

    let imageCounter = 0;
    const imageList: any[] = [];

    // 转换 Word 为 HTML,提取图片
    const result = await mammoth.convertToHtml(
      { path: resolvedInputPath },
      {
        convertImage: mammoth.images.inline((element: any) => {
          imageCounter += 1;
          const extension = element.contentType.split('/')[1] || 'png';
          const imageName = `img_${String(imageCounter).padStart(3, '0')}.${extension}`;
          
          // 根据参数决定图片路径
          const imagePath = imagesInModule 
            ? path.join(outputRootDir, 'images-temp', imageName)
            : path.join(assetsDir!, imageName);

          return element.read().then(async (imageBuffer: Buffer) => {
            const targetDir = imagesInModule 
              ? path.join(outputRootDir, 'images-temp')
              : assetsDir!;
            await fs.ensureDir(targetDir);
            await fs.writeFile(imagePath, imageBuffer);
            imageList.push({ 
              index: imageCounter, 
              name: imageName, 
              path: imagePath,
              relativePath: imagesInModule ? `../assets/${imageName}` : `../../assets/${imageName}`
            });
            return { src: imageList[imageList.length - 1].relativePath };
          });
        })
      }
    );

    const html = result.value;
    const turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced'
    });

    const markdown = turndownService.turndown(html);

    if (splitLevel > 0) {
      // 按标题级别拆分文档(支持层级结构)
      await splitByHeadingsHierarchical(markdown, outputRootDir, splitLevel, imageList, fullFileName, {
        modules,
        imagesInModule
      });
      console.log(`Successfully extracted ${imageCounter} images.`);
      console.log(`Split markdown saved to: ${outputRootDir}`);
    } else {
      // 不拆分,保存为单个文件
      const mdOutputPath = path.join(outputRootDir, `${fullFileName}.md`);
      await fs.writeFile(mdOutputPath, markdown, 'utf8');
      console.log(`Successfully extracted ${imageCounter} images.`);
      console.log(`Markdown saved to: ${mdOutputPath}`);
    }
  } catch (error: any) {
    console.error('Conversion failed:', error.message || error);
    throw error;
  }
}
