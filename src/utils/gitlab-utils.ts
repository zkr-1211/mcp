/**
 * GitLab URL 解析工具
 * 提供统一的 GitLab URL 解析和 API 转换功能
 */

/**
 * GitLab URL 解析结果
 */
export interface GitLabUrlInfo {
  host: string;
  projectPath: string;
  ref: string;
  path: string;
}

/**
 * 解析 GitLab URL（支持 tree 和 raw 格式）
 * 自动尝试不同的分割点找到正确的 ref 和 path
 * 
 * @param url GitLab URL（tree 或 raw 格式）
 * @param urlType URL 类型：'tree' 或 'raw'
 * @returns 解析结果，失败返回 null
 */
export async function parseGitLabUrl(
  url: string,
  urlType: 'tree' | 'raw' = 'tree'
): Promise<GitLabUrlInfo | null> {
  // 匹配: http(s)://host/namespace/project/tree|raw/ref/path
  const pattern = urlType === 'tree' ? '/tree/' : '/raw/';
  const match = url.match(new RegExp(`^(https?:\\/\\/[^\\/]+)\\/(.+)${pattern.replace('/', '\\/')}(.+)$`));
  
  if (!match) {
    return null;
  }
  
  const [, host, projectPath, refAndPath] = match;
  const gitlabToken = process.env.GITLAB_TOKEN;
  
  // 尝试不同的分割点,找到正确的 ref
  const parts = refAndPath.split('/');
  
  for (let i = 1; i < parts.length; i++) {
    const ref = parts.slice(0, i).join('/');
    const path = parts.slice(i).join('/');
    
    // 构建 API URL 测试
    const encodedProjectPath = encodeURIComponent(projectPath);
    const testUrl = urlType === 'tree'
      ? `${host}/api/v4/projects/${encodedProjectPath}/repository/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=1`
      : `${host}/api/v4/projects/${encodedProjectPath}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
    
    try {
      const headers: Record<string, string> = {};
      if (gitlabToken) {
        headers['PRIVATE-TOKEN'] = gitlabToken;
      }
      
      const response = await fetch(testUrl, { 
        method: urlType === 'raw' ? 'HEAD' : 'GET',
        headers 
      });
      
      if (response.ok) {
        // 找到了正确的分割点
        return { host, projectPath, ref, path };
      }
    } catch {
      // 继续尝试下一个分割点
    }
  }
  
  // 如果都失败了,返回默认分割(第一部分是 ref,其余是 path)
  if (parts.length >= 2) {
    return {
      host,
      projectPath,
      ref: parts[0],
      path: parts.slice(1).join('/')
    };
  }
  
  return null;
}

/**
 * 构建 GitLab API 请求头
 * 自动添加 PRIVATE-TOKEN（如果配置了 GITLAB_TOKEN）
 */
export function buildGitLabHeaders(additionalHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...additionalHeaders,
  };
  
  const gitlabToken = process.env.GITLAB_TOKEN;
  if (gitlabToken) {
    headers['PRIVATE-TOKEN'] = gitlabToken;
  }
  
  return headers;
}

/**
 * 构建 GitLab API URL
 */
export function buildGitLabApiUrl(
  host: string,
  projectPath: string,
  endpoint: string,
  params: Record<string, string> = {}
): string {
  const encodedProjectPath = encodeURIComponent(projectPath);
  const queryParams = new URLSearchParams(params).toString();
  const queryString = queryParams ? `?${queryParams}` : '';
  
  return `${host}/api/v4/projects/${encodedProjectPath}/${endpoint}${queryString}`;
}

/**
 * 安全地调用 GitLab API
 * 自动处理认证和错误
 */
export async function callGitLabApi(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = buildGitLabHeaders(options.headers as Record<string, string>);
  
  return fetch(url, {
    ...options,
    headers,
  });
}
