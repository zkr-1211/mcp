/**
 * 文档层级拆分与树结构构建
 * 负责: 标题解析、层级树构建、模块过滤、递归写入
 */

import fs from 'fs-extra';
import path from 'path';
import { filterSectionsByModules } from './filter.js';
import { writeSectionRecursive, generateIndexMD, generateSummaryJSON } from './writer.js';

/**
 * 按标题级别拆分文档(支持层级结构)
 */
export async function splitByHeadingsHierarchical(
  markdown: string,
  outputRootDir: string,
  maxLevel: number,
  imageList: any[],
  sourceDoc: string,
  options: { modules?: string[] | null; imagesInModule?: boolean } = {}
): Promise<void> {
  const { modules = null, imagesInModule = false } = options;
  
  // 匹配所有 1~maxLevel 级别的标题
  const headingRegex = new RegExp(`^(#{1,${maxLevel}})\\s+(.+)$`, 'gm');
  
  const sections: any[] = [];
  let match;

  // 查找所有标题,记录层级和位置
  while ((match = headingRegex.exec(markdown)) !== null) {
    const level = match[1].length;
    const title = match[2].trim();
    const startIdx = match.index;
    
    sections.push({
      level,
      title,
      startIdx,
      content: '',
      children: [],
      parent: null
    });
  }

  // 为每个章节分配内容(从当前标题到下一个同级或更高级标题之前)
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    let endIdx = markdown.length;
    
    // 查找结束位置:下一个同级或更高级的标题
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= section.level) {
        endIdx = sections[j].startIdx;
        break;
      }
    }
    
    section.content = markdown.substring(section.startIdx, endIdx).trim();
  }

  // 构建层级树结构
  const rootSections: any[] = [];
  const stack: any[] = [];

  for (const section of sections) {
    // 弹出栈中所有层级大于等于当前层级的节点
    while (stack.length > 0 && stack[stack.length - 1].level >= section.level) {
      stack.pop();
    }
    
    // 如果栈不为空,当前节点是栈顶节点的子节点
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      section.parent = parent;
      parent.children.push(section);
    } else {
      rootSections.push(section);
    }
    
    stack.push(section);
  }

  // 如果指定了模块过滤,则只保留匹配的模块及其父级路径
  let filteredSections = rootSections;
  if (modules && modules.length > 0) {
    filteredSections = filterSectionsByModules(rootSections, modules);
    console.log(`Filtering modules: ${modules.join(', ')}`);
  }

  // 生成目录名并写入文件
  const chunks: any[] = [];
  
  for (const section of filteredSections) {
    await writeSectionRecursive(section, outputRootDir, [], chunks, imageList, sourceDoc, {
      imagesInModule,
      outputRootDir
    });
  }

  // 生成 index.md (树形目录结构)
  await generateIndexMD(filteredSections, outputRootDir);
  
  // 生成 summary.json
  await generateSummaryJSON(chunks, outputRootDir, sourceDoc);
  
  // 如果图片在模块下,删除临时目录
  if (imagesInModule) {
    const tempImagesDir = path.join(outputRootDir, 'images-temp');
    if (await fs.pathExists(tempImagesDir)) {
      await fs.remove(tempImagesDir);
    }
  }
  
  console.log(`Document split into ${chunks.length} chunks with hierarchical structure.`);
}
