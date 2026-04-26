/**
 * 测试 Word 转 Markdown 功能
 */

import { convertWordToMd } from './src/scripts/converter.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const testFile = join(__dirname, '31539【A类】加油商户营销及开票需求.docx');

console.log('🧪 开始测试 Word 转 Markdown 功能...');
console.log('📄 测试文件:', testFile);
console.log('');

convertWordToMd(testFile, {
  splitLevel: 2,
  modules: null,
  imagesInModule: false
})
  .then(() => {
    console.log('');
    console.log('✅ 测试成功！转换完成');
  })
  .catch((error) => {
    console.error('');
    console.error('❌ 测试失败:', error.message);
    process.exit(1);
  });
