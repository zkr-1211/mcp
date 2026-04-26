/**
 * 文件写入与输出生成
 * 负责: 章节写入、图片分配、索引文件生成、JSON 摘要生成
 */

import fs from 'fs-extra';
import path from 'path';
import { sanitizeDirName, getPathFromRoot } from './utils.js';

/**
 * 递归写入章节及其子章节
 */
export async function writeSectionRecursive(
  section: any,
  outputRootDir: string,
  breadcrumbs: string[],
  chunks: any[],
  imageList: any[],
  sourceDoc: string,
  options: { imagesInModule?: boolean; outputRootDir?: string } = {}
): Promise<void> {
  const { imagesInModule = false } = options;
  
  const dirName = sanitizeDirName(section.title);
  const sectionPath = breadcrumbs.length > 0 
    ? path.join(...breadcrumbs.map(b => sanitizeDirName(b)), dirName)
    : dirName;
  
  const fullDirPath = path.join(outputRootDir, sectionPath);
  await fs.ensureDir(fullDirPath);
  
  // 构建当前章节的完整面包屑(包含父级标题)
  const currentBreadcrumbs = [...breadcrumbs, section.title];
  
  // 计算相对于根目录的路径
  const relativePath = path.join(sectionPath, 'index.md');
  const parentPath = breadcrumbs.length > 0 
    ? path.join(...breadcrumbs.map(b => sanitizeDirName(b)), 'index.md')
    : null;
  
  // 如果图片在模块下,复制相关图片到当前模块目录
  let updatedContent = section.content;
  const moduleImages: any[] = [];
  
  if (imagesInModule) {
    const moduleAssetsDir = path.join(fullDirPath, 'assets');
    await fs.ensureDir(moduleAssetsDir);
    
    // 查找当前章节内容中的图片引用(匹配各种可能的路径格式)
    const imageRegex = /(?:\.\.\/)*(?:assets\/|images-temp\/)(img_\d+\.\w+)/g;
    let imgMatch;
    
    // 先使用原始路径查找图片(../../assets/ 或 ../assets/)
    const originalContent = section.content;
    while ((imgMatch = imageRegex.exec(originalContent)) !== null) {
      const imageName = imgMatch[1];
      const imageInfo = imageList.find(img => img.name === imageName);
      if (imageInfo) {
        moduleImages.push({ name: imageName, info: imageInfo });
      }
    }
    
    // 复制图片到模块的 assets 目录
    for (const { name, info } of moduleImages) {
      if (await fs.pathExists(info.path)) {
        await fs.copy(info.path, path.join(moduleAssetsDir, name));
      }
    }
    
    // 更新内容中的图片路径(统一改为 ./assets/)
    updatedContent = originalContent
      .replace(/(?:\.\.\/)+(?:assets|images-temp)\//g, './assets/');
  } else {
    updatedContent = section.content;
  }
  
  // 生成 YAML frontmatter
  const frontmatter = [
    '---',
    `title: "${section.title}"`,
    `level: ${section.level}`,
    `chunk_id: "${sectionPath}"`,
    `source_doc: "${sourceDoc}.docx"`,
    `path: "${relativePath}"`,
    `parent_path: ${parentPath ? `"${parentPath}"` : 'null'}`,
    'breadcrumbs:',
    currentBreadcrumbs.length > 1 
      ? currentBreadcrumbs.slice(0, -1).map(b => `  - "${b}"`).join('\n')
      : ' []',
    '---',
    ''
  ].join('\n');
  
  // 写入 index.md
  const mdContent = frontmatter + updatedContent + '\n';
  await fs.writeFile(path.join(fullDirPath, 'index.md'), mdContent, 'utf8');
  
  // 记录 chunk 信息
  chunks.push({
    chunk_id: sectionPath,
    title: section.title,
    level: section.level,
    path: relativePath,
    breadcrumbs: breadcrumbs
  });
  
  // 递归处理子章节
  for (const child of section.children) {
    await writeSectionRecursive(child, outputRootDir, currentBreadcrumbs, chunks, imageList, sourceDoc, options);
  }
}

/**
 * 生成 index.md (树形目录)
 */
export async function generateIndexMD(rootSections: any[], outputRootDir: string): Promise<void> {
  const lines: string[] = ['# Index\n'];
  
  function renderSection(section: any, indent = 0): void {
    const dirName = sanitizeDirName(section.title);
    
    // 构建从根到当前节点的完整路径(使用目录名)
    const pathParts: string[] = [];
    let current = section;
    while (current) {
      pathParts.unshift(sanitizeDirName(current.title));
      current = current.parent;
    }
    
    const fullPath = pathParts.join('/');
    const relativeLink = `./${fullPath}/index.md`;
    
    const prefix = '  '.repeat(indent);
    const breadcrumb = section.parent 
      ? ` (${getPathFromRoot(section).join(' / ')} / ${section.title})`
      : '';
    
    lines.push(`${prefix}- [${section.title}](${relativeLink})${breadcrumb}`);
    
    for (const child of section.children) {
      renderSection(child, indent + 1);
    }
  }
  
  for (const section of rootSections) {
    renderSection(section);
  }
  
  await fs.writeFile(path.join(outputRootDir, 'index.md'), lines.join('\n') + '\n', 'utf8');
}

/**
 * 生成 summary.json
 */
export async function generateSummaryJSON(chunks: any[], outputRootDir: string, sourceDoc: string): Promise<void> {
  const summary = {
    source_doc: `${sourceDoc}.docx`,
    chunks: chunks.map(c => ({
      chunk_id: c.chunk_id,
      title: c.title,
      level: c.level,
      path: c.path,
      breadcrumbs: c.breadcrumbs
    }))
  };
  
  await fs.writeFile(
    path.join(outputRootDir, 'summary.json'), 
    JSON.stringify(summary, null, 2), 
    'utf8'
  );
}
