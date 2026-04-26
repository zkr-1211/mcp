/**
 * 工具函数
 * 负责: 路径清理、格式化、路径计算
 */

/**
 * 清理目录名(保留中文、字母、数字,并将点号转为连字符)
 */
export function sanitizeDirName(title: string): string {
  const titleStr = String(title || '');
  return titleStr
    .replace(/\.(?=\d)/g, '-')  // 将数字前的点号转为连字符 (5.1 -> 5-1)
    .replace(/[^\w\s\u4e00-\u9fa5-]/g, '')  // 保留中文、字母、数字、空格、连字符
    .replace(/\s+/g, '-')
    .toLowerCase() || 'untitled';
}

/**
 * 获取从根到当前节点的路径标题数组
 */
export function getPathFromRoot(section: any): string[] {
  const pathArr: string[] = [];
  let current = section;
  while (current) {
    pathArr.unshift(current.title);
    current = current.parent;
  }
  return pathArr;
}
