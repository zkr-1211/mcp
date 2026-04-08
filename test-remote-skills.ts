#!/usr/bin/env node
/**
 * 测试远程 skill 加载
 * 用法: SKILLS_URL=http://xxx SKILLS_LIST=ci,cd npx tsx test-remote-skills.ts
 */

import { 
  getAvailableSkills, 
  getSkillContent, 
  getSkillMetadata
} from './src/utils/skill-loader.js';

async function main() {
  console.log('=== 远程 Skill 加载测试 ===\n');
  
  // 1. 检查环境变量
  console.log('1. 环境变量检查:');
  console.log('   SKILLS_URL:', process.env.SKILLS_URL || '未设置');
  console.log('   SKILLS_LIST:', process.env.SKILLS_LIST || '未设置');
  console.log();
  
  // 2. 显示配置信息
  console.log('2. 配置信息:');
  console.log('   如果 SKILLS_URL 设置,将使用远程模式');
  console.log('   如果未设置,将使用本地模式');
  console.log();
  
  // 3. 获取可用 skills 列表
  console.log('3. 获取可用 skills 列表:');
  try {
    const skills = await getAvailableSkills();
    console.log('   发现 skills:', skills);
  } catch (error: any) {
    console.error('   错误:', error.message);
  }
  console.log();
  
  // 4. 获取每个 skill 的内容和元数据
  console.log('4. 获取每个 skill 的详细信息:');
  try {
    const skills = await getAvailableSkills();
    for (const skillName of skills) {
      console.log(`\n   --- ${skillName} ---`);
      
      // 获取内容
      const content = await getSkillContent(skillName);
      console.log(`   内容长度: ${content.length} 字符`);
      console.log(`   内容前 200 字符:\n${content.substring(0, 200)}...`);
      
      // 获取元数据
      const metadata = await getSkillMetadata(skillName);
      console.log(`   元数据:`, JSON.stringify(metadata, null, 2));
    }
  } catch (error: any) {
    console.error('   错误:', error.message);
  }
  
  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);
