/**
 * 模块过滤与匹配逻辑
 * 负责: 章节树过滤、模块名称匹配
 */

/**
 * 检查标题是否匹配模块列表
 */
function matchModule(title: string, modules: string[]): boolean {
  for (const module of modules) {
    // 支持 "5.1" 或 "5" 或 "5.1商户平台" 等格式匹配
    if (title.startsWith(module) || title === module) {
      return true;
    }
    // 支持数字部分匹配 (5.1, 5-1, 51 都应该匹配)
    const normalizedTitle = title.replace(/[.\s-]/g, '');
    const normalizedModule = module.replace(/[.\s-]/g, '');
    if (normalizedTitle.startsWith(normalizedModule)) {
      return true;
    }
  }
  return false;
}

/**
 * 根据模块过滤章节树
 */
export function filterSectionsByModules(sections: any[], modules: string[]): any[] {
  const result: any[] = [];
  
  for (const section of sections) {
    // 检查当前模块是否匹配
    const isMatch = matchModule(section.title, modules);
    
    if (isMatch) {
      // 匹配,包含整个子树
      result.push(section);
    } else if (section.children.length > 0) {
      // 检查子节点是否有匹配
      const matchedChildren = filterSectionsByModules(section.children, modules);
      if (matchedChildren.length > 0) {
        // 有子节点匹配,保留当前节点和匹配的子节点
        const clonedSection = { ...section, children: matchedChildren };
        result.push(clonedSection);
      }
    }
  }
  
  return result;
}
