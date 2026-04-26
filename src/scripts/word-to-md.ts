/**
 * Word to Markdown 转换工具 - 主入口
 * 
 * 模块说明:
 * - converter.ts: Word文档转换核心逻辑
 * - splitter.ts: 文档层级拆分与树结构构建
 * - filter.ts: 模块过滤与匹配逻辑  
 * - writer.ts: 文件写入与输出生成
 * - utils.ts: 工具函数(路径清理、格式化等)
 */

export { convertWordToMd, ConvertOptions } from './converter.js';
