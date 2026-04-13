/**
 * 测试远程 MCP 工具配置加载
 */
import * as yaml from 'js-yaml';

const configUrl = 'http://192.168.162.164:9081/zhangkr/ai-test/raw/feature/2026/postar-pipe-mcp/mcp-tools-config.yaml';

async function testRemoteConfig() {
  console.log('🧪 开始测试远程 MCP 工具配置...\n');
  console.log(`📡 配置 URL: ${configUrl}\n`);

  try {
    let apiUrl = configUrl;
    const gitlabToken = process.env.GITLAB_TOKEN;

    // 如果是 Web URL，转换为 GitLab API
    if (!configUrl.includes('/api/v4/')) {
      console.log('1️⃣ 转换为 GitLab API 格式...');
      const match = configUrl.match(/^(https?:\/\/[^\/]+)\/(.+)\/raw\/(.+)$/);
      if (match) {
        const [, host, projectPath, refAndPath] = match;
        const encodedProjectPath = encodeURIComponent(projectPath);
        
        // 尝试不同的分割点,找到正确的 ref
        const parts = refAndPath.split('/');
        let foundApiUrl: string | null = null;
        
        console.log(`   尝试分割点: ${parts.join(' / ')}`);
        
        for (let i = 1; i < parts.length; i++) {
          const ref = parts.slice(0, i).join('/');
          const filePath = parts.slice(i).join('/');
          
          // 构建 API URL 测试
          const testUrl = `${host}/api/v4/projects/${encodedProjectPath}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
          
          try {
            const testHeaders: Record<string, string> = {};
            if (gitlabToken) {
              testHeaders['PRIVATE-TOKEN'] = gitlabToken;
            }
            
            const testResponse = await fetch(testUrl, { 
              method: 'HEAD',
              headers: testHeaders 
            });
            
            if (testResponse.ok) {
              foundApiUrl = testUrl;
              console.log(`   ✅ 找到正确的 API URL (ref=${ref})`);
              break;
            } else {
              console.log(`   ❌ ref=${ref} 失败 (${testResponse.status})`);
            }
          } catch (e: any) {
            console.log(`   ❌ ref=${ref} 异常: ${e.message}`);
          }
        }
        
        if (foundApiUrl) {
          apiUrl = foundApiUrl;
          console.log(`✅ API URL: ${apiUrl}\n`);
        } else {
          // 如果都失败了，使用默认分割（第一部分是 ref）
          const ref = parts[0];
          const filePath = parts.slice(1).join('/');
          apiUrl = `${host}/api/v4/projects/${encodedProjectPath}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
          console.log(`⚠️  使用默认分割: ref=${ref}, file=${filePath}`);
          console.log(`✅ API URL: ${apiUrl}\n`);
        }
      } else {
        console.error('❌ 无法解析 URL 格式');
        return;
      }
    }

    // 测试 URL 是否可访问
    console.log('2️⃣ 测试 API 可访问性...');
    const headers: Record<string, string> = {
      'Accept': 'text/yaml, text/plain, */*',
    };
    
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
      console.log('✅ 使用 GitLab Token 认证\n');
    } else {
      console.log('⚠️  未配置 GITLAB_TOKEN（从环境变量读取）\n');
    }
    
    const response = await fetch(apiUrl, { headers });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ HTTP 请求失败: ${response.status} ${response.statusText}`);
      console.error(`📄 错误详情: ${errorText.substring(0, 300)}`);
      return;
    }
    console.log(`✅ HTTP 请求成功 (${response.status})\n`);

    // 获取内容
    console.log('3️⃣ 获取配置内容...');
    const content = await response.text();
    
    // 检查是否返回 HTML
    if (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html')) {
      console.error('❌ 返回了 HTML 页面，认证可能失败');
      console.error('\n💡 请确保:');
      console.error('   1. 设置了 GITLAB_TOKEN 环境变量');
      console.error('   2. Token 有 read_repository 权限');
      return;
    }
    console.log('✅ 获取到 YAML 内容\n');

    // 解析 YAML
    console.log('4️⃣ 解析 YAML 配置...');
    const config = yaml.load(content) as any;
    console.log('✅ YAML 解析成功\n');

    // 显示配置内容
    console.log('5️⃣ 配置内容:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify(config, null, 2));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 验证配置结构
    console.log('6️⃣ 验证配置结构...');
    if (config.gitlab) {
      console.log(`✅ GitLab 配置:`);
      console.log(`   - enabled: ${config.gitlab.enabled?.length || 0} 个工具`);
      console.log(`   - disabled: ${config.gitlab.disabled?.length || 0} 个工具`);
      if (config.gitlab.enabled) {
        console.log(`   - 工具列表: ${config.gitlab.enabled.join(', ')}`);
      }
    } else {
      console.log('⚠️  未找到 gitlab 配置');
    }

    if (config.jenkins) {
      console.log(`\n✅ Jenkins 配置:`);
      console.log(`   - enabled: ${config.jenkins.enabled?.length || 0} 个工具`);
      console.log(`   - disabled: ${config.jenkins.disabled?.length || 0} 个工具`);
      if (config.jenkins.enabled) {
        console.log(`   - 工具列表: ${config.jenkins.enabled.join(', ')}`);
      }
    } else {
      console.log('\n⚠️  未找到 jenkins 配置');
    }

    console.log('\n✅ 测试完成！配置加载成功');

  } catch (error: any) {
    console.error(`\n❌ 测试失败: ${error.message}`);
    console.error('\n可能的原因:');
    console.error('1. URL 格式不正确');
    console.error('2. 网络连接问题');
    console.error('3. 需要 GitLab Token 认证（设置 GITLAB_TOKEN 环境变量）');
  }
}

testRemoteConfig();
