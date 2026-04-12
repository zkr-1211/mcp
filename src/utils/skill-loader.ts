/**
 * Skill 文件加载器
 * 支持本地文件系统和远程 HTTP(S) 加载
 */
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import * as yaml from 'js-yaml';

// 缓存 skill 内容(带时间戳)
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const skillCache: Map<string, CacheEntry<string>> = new Map();
const skillMetadataCache: Map<string, CacheEntry<SkillMetadata>> = new Map();

// 远程 skill 列表缓存(带时间戳)
let remoteSkillsList: CacheEntry<string[]> | null = null;

/**
 * Skill 源配置
 */
interface SkillSource {
  name: string; // 源名称,用于区分不同来源的 skill
  baseUrl: string; // raw URL
  originalUrl: string; // 原始 tree URL,用于解析
  skillsList?: string[]; // 该源指定的 skill 列表(从查询参数解析)
}

/**
 * Skill 加载配置
 */
interface SkillsConfig {
  source: 'local' | 'remote';
  sources?: SkillSource[]; // 多个远程源配置
  baseUrl?: string; // 兼容单 URL 模式
  originalUrl?: string; // 原始 tree URL,用于解析
  skills?: string[]; // 手动指定的 skill 列表
}

/**
 * 解析单个 URL 为 SkillSource
 * 支持从查询参数提取 skills 列表: ?skills=ci,cd
 */
function parseSkillSource(url: string, index: number): SkillSource {
  // 分离查询参数
  const questionMarkIndex = url.indexOf('?');
  let cleanUrl = url;
  let skillsList: string[] | undefined;

  if (questionMarkIndex !== -1) {
    cleanUrl = url.substring(0, questionMarkIndex);
    const queryString = url.substring(questionMarkIndex + 1);
    
    // 解析查询参数
    const params = new URLSearchParams(queryString);
    const skillsParam = params.get('skills');
    
    if (skillsParam) {
      skillsList = skillsParam
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    }
  }

  const rawUrl = cleanUrl
    .replace('/tree/', '/raw/')
    .replace(/\/$/, ''); // 去除末尾斜杠

  // 从 URL 中提取项目名称作为源名称
  const match = cleanUrl.match(/\/([^\/]+)\/[^\/]+\/tree\//);
  const name = match ? match[1] : `source-${index}`;

  return {
    name,
    baseUrl: rawUrl,
    originalUrl: cleanUrl,
    skillsList,
  };
}

/**
 * 从命令行参数解析 skills URLs
 * 支持多种格式:
 * 1. 多个 --skill-url "url" 参数（推荐，数组格式）
 * 2. --skills-urls="url1,url2" 逗号分隔格式
 * 3. --skills-url="url" 单 URL 格式
 */
function parseCommandLineArgs(): { skillUrls?: string[]; skillsUrls?: string; skillsUrl?: string } {
  const result: { skillUrls?: string[]; skillsUrls?: string; skillsUrl?: string } = {};
  const skillUrls: string[] = [];

  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];

    // 支持多个 --skill-url "url" 参数（数组格式）
    if (arg === '--skill-url' && i + 1 < process.argv.length) {
      skillUrls.push(process.argv[i + 1]);
    } else if (arg.startsWith('--skill-url=')) {
      skillUrls.push(arg.split('=')[1]);
    }

    // 支持 --skills-urls="url1,url2" 或 --skills-urls url1,url2
    if (arg.startsWith('--skills-urls=')) {
      result.skillsUrls = arg.split('=')[1];
    } else if (arg === '--skills-urls' && i + 1 < process.argv.length) {
      result.skillsUrls = process.argv[i + 1];
    }

    // 支持 --skills-url="url" 或 --skills-url url
    if (arg.startsWith('--skills-url=')) {
      result.skillsUrl = arg.split('=')[1];
    } else if (arg === '--skills-url' && i + 1 < process.argv.length) {
      result.skillsUrl = process.argv[i + 1];
    }
  }

  if (skillUrls.length > 0) {
    result.skillUrls = skillUrls;
  }

  return result;
}

/**
 * 获取 Skills 配置
 * 优先级: 命令行参数(数组) > 命令行参数(字符串) > 环境变量 > 本地模式
 */
function getSkillsConfig(): SkillsConfig {
  const cliArgs = parseCommandLineArgs();

  // 1. 优先处理命令行数组格式: 多个 --skill-url
  if (cliArgs.skillUrls && cliArgs.skillUrls.length > 0) {
    const sources = cliArgs.skillUrls
      .map((url: string, index: number) => parseSkillSource(url.trim(), index))
      .filter((source: SkillSource) => source.originalUrl.length > 0);

    if (sources.length > 0) {
      return {
        source: 'remote',
        sources,
        baseUrl: sources[0].baseUrl,
        originalUrl: sources[0].originalUrl,
      };
    }
  }

  // 2. 处理逗号分隔格式: --skills-urls
  const skillsUrls = cliArgs.skillsUrls || process.env.SKILLS_URLS;
  if (skillsUrls) {
    const sources = skillsUrls
      .split(',')
      .map((url: string, index: number) => parseSkillSource(url.trim(), index))
      .filter((source: SkillSource) => source.originalUrl.length > 0);

    if (sources.length > 0) {
      return {
        source: 'remote',
        sources,
        baseUrl: sources[0].baseUrl,
        originalUrl: sources[0].originalUrl,
      };
    }
  }

  // 3. 单 URL 模式
  const skillsUrl = cliArgs.skillsUrl || process.env.SKILLS_URL;
  if (skillsUrl) {
    const source = parseSkillSource(skillsUrl, 0);
    return {
      source: 'remote',
      sources: [source],
      baseUrl: source.baseUrl,
      originalUrl: source.originalUrl,
    };
  }

  return {
    source: 'local',
  };
}

/**
 * 解析 GitLab URL
 * 从 tree URL 中提取项目路径、分支和目录路径
 * 
 * URL 格式: http(s)://host/namespace/project/tree/ref/path
 * 问题: ref 可能包含 / (如 feature/2026),路径也可能包含 /
 * 
 * 解决策略:使用 GitLab API 尝试不同的 ref/path 分割点
 */
async function parseGitLabUrl(treeUrl: string): Promise<{ host: string; projectPath: string; ref: string; path: string } | null> {
  // 匹配: http(s)://host/namespace/project/tree/ref/path
  const match = treeUrl.match(/^(https?:\/\/[^\/]+)\/(.+)\/tree\/(.+)$/);
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
    const testUrl = `${host}/api/v4/projects/${encodedProjectPath}/repository/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=1`;
    
    try {
      const headers: Record<string, string> = {};
      if (gitlabToken) {
        headers['PRIVATE-TOKEN'] = gitlabToken;
      }
      
      const response = await fetch(testUrl, { headers });
      
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
 * 判断是否为远程模式
 */
function isRemoteMode(): boolean {
  return getSkillsConfig().source === 'remote';
}

/**
 * 从远程目录遍历获取 skill 列表
 * 通过 GitLab API 获取目录下的所有子目录
 */
async function fetchRemoteSkillsFromDirectory(config: SkillsConfig): Promise<string[]> {
  try {
    // 使用原始 tree URL 来解析
    const treeUrl = config.originalUrl;
    if (!treeUrl) {
      console.error(`[SKILL-LOADER] 缺少原始 URL 信息`);
      return [];
    }
    
    // 解析 tree URL
    const parsed = await parseGitLabUrl(treeUrl);
    if (!parsed) {
      console.error(`[SKILL-LOADER] 无法解析 URL: ${treeUrl}`);
      return [];
    }
    
    const { host, projectPath, ref, path } = parsed;
    
    // 构建 GitLab API URL
    const encodedProjectPath = encodeURIComponent(projectPath);
    const apiUrl = `${host}/api/v4/projects/${encodedProjectPath}/repository/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`;
    
    console.error(`[SKILL-LOADER] GitLab API URL: ${apiUrl}`);
    
    // 构建请求头
    const headers: Record<string, string> = {};
    const gitlabToken = process.env.GITLAB_TOKEN;
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }
    
    const response = await fetch(apiUrl, { headers });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SKILL-LOADER] GitLab API 错误响应: ${errorText}`);
      throw new Error(`GitLab API 请求失败: ${response.status}`);
    }
    
    const items = await response.json() as Array<{ name: string; type: string }>;
    const skills = items
      .filter(item => item.type === 'tree') // 只保留目录
      .map(item => item.name);
    
    console.error(`[SKILL-LOADER] 从远程目录遍历发现 skills: ${skills.join(', ')}`);
    return skills;
  } catch (error: any) {
    console.error(`[SKILL-LOADER] 遍历远程目录失败:`, error.message);
    return [];
  }
}

/**
 * Skill 来源映射缓存: skillName -> source
 */
const skillSourceMap: Map<string, SkillSource> = new Map();

/**
 * 缓存 TTL 配置(默认 30 分钟)
 * 可通过环境变量 SKILLS_CACHE_TTL 配置(单位: 分钟)
 */
const CACHE_TTL_MINUTES = process.env.SKILLS_CACHE_TTL 
  ? parseInt(process.env.SKILLS_CACHE_TTL) 
  : 30; // 默认 30 分钟

// 转换为毫秒
const CACHE_TTL = CACHE_TTL_MINUTES * 60 * 1000;

/**
 * 检查缓存是否过期
 */
function isCacheExpired(timestamp: number): boolean {
  return Date.now() - timestamp > CACHE_TTL;
}

/**
 * 获取远程 skill 列表(支持多源汇总)
 * 优先从源配置的 skillsList 读取,否则从环境变量 SKILLS_LIST 读取
 * 如果都未配置则自动遍历所有远程目录
 * 支持 TTL 缓存,过期自动刷新
 */
async function fetchRemoteSkillsList(config: SkillsConfig): Promise<string[]> {
  // 检查缓存是否有效
  if (remoteSkillsList && !isCacheExpired(remoteSkillsList.timestamp)) {
    return remoteSkillsList.data;
  }

  console.error(`[SKILL-LOADER] Skills 列表缓存过期或不存在,重新加载...`);

  const skillsListEnv = process.env.SKILLS_LIST;

  // 如果配置了全局 SKILLS_LIST,使用全局配置
  if (skillsListEnv) {
    const skills = skillsListEnv
      .split(',')
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    remoteSkillsList = { data: skills, timestamp: Date.now() };
    console.error(`[SKILL-LOADER] 从环境变量加载 skills: ${skills.join(', ')}`);
    return skills;
  }

  // 未配置 SKILLS_LIST,检查各源是否有独立的 skillsList
  console.error(`[SKILL-LOADER] 未配置 SKILLS_LIST,检查各源独立配置...`);

  const allSkills: string[] = [];
  skillSourceMap.clear();

  if (config.sources && config.sources.length > 0) {
    // 多源模式:遍历所有源
    for (const source of config.sources) {
      console.error(`[SKILL-LOADER] 扫描源: ${source.name} (${source.originalUrl})`);

      if (source.skillsList && source.skillsList.length > 0) {
        // 该源有独立的 skills 列表配置
        console.error(`[SKILL-LOADER] 源 ${source.name} 使用独立 skills 列表: ${source.skillsList.join(', ')}`);
        
        for (const skillName of source.skillsList) {
          if (!allSkills.includes(skillName)) {
            allSkills.push(skillName);
          }
          skillSourceMap.set(skillName, source);
        }
      } else {
        // 该源没有独立配置,自动遍历目录
        console.error(`[SKILL-LOADER] 源 ${source.name} 未配置独立 skills,自动遍历目录...`);
        const sourceConfig: SkillsConfig = {
          source: 'remote',
          baseUrl: source.baseUrl,
          originalUrl: source.originalUrl,
        };

        const skills = await fetchRemoteSkillsFromDirectory(sourceConfig);
        console.error(`[SKILL-LOADER] 源 ${source.name} 发现 skills: ${skills.join(', ')}`);

        // 记录每个 skill 的来源,后加载的 skill 会覆盖先加载的(优先级)
        for (const skillName of skills) {
          if (!allSkills.includes(skillName)) {
            allSkills.push(skillName);
          }
          skillSourceMap.set(skillName, source);
        }
      }
    }
  } else if (config.baseUrl && config.originalUrl) {
    // 单源模式(兼容旧代码)
    const skills = await fetchRemoteSkillsFromDirectory(config);
    for (const skillName of skills) {
      allSkills.push(skillName);
      skillSourceMap.set(skillName, {
        name: 'default',
        baseUrl: config.baseUrl,
        originalUrl: config.originalUrl,
      });
    }
  }

  console.error(`[SKILL-LOADER] 汇总所有 skills: ${allSkills.join(', ')}`);
  remoteSkillsList = { data: allSkills, timestamp: Date.now() };
  return allSkills;
}

/**
 * 从远程加载 skill 内容
 * 支持 GitLab Private Token 认证
 * 失败时自动降级到本地文件
 */
async function loadRemoteSkillContent(skillName: string, baseUrl: string): Promise<string> {
  const skillUrl = `${baseUrl}/${skillName}/SKILL.md`;
  
  try {
    // 构建请求头,支持 GitLab Private Token
    const headers: Record<string, string> = {
      'Accept': 'text/markdown, text/plain, */*',
    };
    
    const gitlabToken = process.env.GITLAB_TOKEN;
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }
    
    const response = await fetch(skillUrl, { headers });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const content = await response.text();
    
    // 检查是否返回了 HTML 页面(说明 URL 不正确或认证失败)
    if (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html')) {
      throw new Error(`返回了 HTML 页面,请检查 SKILLS_URL 是否正确或 GITLAB_TOKEN 是否有效`);
    }
    
    return content;
  } catch (error: any) {
    console.error(`[SKILL-LOADER] 远程加载失败: ${skillUrl}, 降级到本地: ${error.message}`);
    // 降级到本地加载
    return loadLocalSkillContent(skillName);
  }
}

/**
 * Skill 工具定义
 */
export interface SkillTool {
  name: string;
  description: string;
  required: boolean;
}

/**
 * Skill 资源定义（可选，用于声明额外资源）
 */
export interface SkillResource {
  path: string;
  type: 'yaml' | 'json' | 'text' | 'directory' | 'binary';
  description?: string;
}

/**
 * Skill 元数据接口
 */
export interface SkillMetadata {
  name: string;
  description: string;
  constraint?: string;
  version?: string;
  tools?: SkillTool[];
  resources?: SkillResource[];
  // 允许其他自定义字段
  [key: string]: any;
}

/**
 * 获取 skills 目录路径
 * 支持开发环境(src)和生产环境(dist)
 */
function getSkillsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // 尝试多个可能的路径（开发环境和生产环境）
  const possiblePaths = [
    // 开发环境: src/utils -> src/skills
    resolve(__dirname, '..', 'skills'),
    // 生产环境: dist/server.js -> dist/skills
    resolve(__dirname, 'skills'),
    // 备选: 相对于项目根目录
    resolve(process.cwd(), 'mcp-pipe-server', 'dist', 'skills'),
    resolve(process.cwd(), 'mcp-pipe-server', 'src', 'skills'),
  ];
  
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }
  
  // 默认返回第一个路径（让后续错误处理显示正确的路径）
  return possiblePaths[0];
}

/**
 * 获取所有可用的 skill 名称
 * 支持本地和远程两种模式
 */
export async function getAvailableSkills(): Promise<string[]> {
  const config = getSkillsConfig();
  
  if (config.source === 'remote' && config.baseUrl) {
    return fetchRemoteSkillsList(config);
  }
  
  // 本地模式
  const skillsDir = getSkillsDir();

  if (!existsSync(skillsDir)) {
    return [];
  }

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
}

/**
 * 从本地加载 skill 内容
 */
function loadLocalSkillContent(skillName: string): string {
  const skillPath = resolve(getSkillsDir(), skillName, 'SKILL.md');

  try {
    return readFileSync(skillPath, 'utf-8');
  } catch (error: any) {
    console.error(`[SKILL-LOADER] 本地加载也失败: ${skillPath}, ${error.message}`);
    return `# ${skillName.toUpperCase()} Skill\n\n⚠️ Skill 文件加载失败(远程和本地均不可用),请检查安装。`;
  }
}

/**
 * 加载 skill 文件内容
 * 支持本地和远程两种模式
 * 远程模式下支持多源:根据 skill 名称从对应的源加载
 * 远程失败时自动降级到本地
 */
async function loadSkillContent(skillName: string): Promise<string> {
  const config = getSkillsConfig();

  if (config.source === 'remote') {
    // 优先从来源映射中查找
    const source = skillSourceMap.get(skillName);
    if (source) {
      console.error(`[SKILL-LOADER] 从源 ${source.name} 加载 skill: ${skillName}`);
      return loadRemoteSkillContent(skillName, source.baseUrl);
    }

    // 如果没有找到映射(可能是手动指定的 skill),尝试从第一个源加载
    if (config.sources && config.sources.length > 0) {
      const firstSource = config.sources[0];
      console.error(`[SKILL-LOADER] 未找到来源映射,使用默认源 ${firstSource.name} 加载: ${skillName}`);
      return loadRemoteSkillContent(skillName, firstSource.baseUrl);
    }

    // 兼容单 URL 模式
    if (config.baseUrl) {
      return loadRemoteSkillContent(skillName, config.baseUrl);
    }
  }

  // 本地模式
  return loadLocalSkillContent(skillName);
}

/**
 * 获取指定 Skill 内容
 * 支持 TTL 缓存,过期自动刷新
 */
export async function getSkillContent(skillName: string): Promise<string> {
  const cached = skillCache.get(skillName);
  
  // 检查缓存是否有效
  if (cached && !isCacheExpired(cached.timestamp)) {
    return cached.data;
  }
  
  // 缓存过期或不存在,重新加载
  console.error(`[SKILL-LOADER] Skill 缓存过期或不存在,重新加载: ${skillName}`);
  const content = await loadSkillContent(skillName);
  skillCache.set(skillName, { data: content, timestamp: Date.now() });
  return content;
}

/**
 * 解析 frontmatter
 * 支持 YAML 格式，包括数组和对象
 */
async function parseFrontmatter(content: string): Promise<{ metadata: Record<string, any>; body: string }> {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { metadata: {}, body: content };
  }

  const frontmatterText = match[1];
  const body = match[2];

  // 尝试使用 YAML 解析（如果可用）
  try {
    const metadata = yaml.load(frontmatterText) || {};
    return { metadata, body };
  } catch {
    // 降级：简单解析 key: value 格式
    const metadata: Record<string, any> = {};
    const lines = frontmatterText.split('\n');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0 && !line.startsWith('-') && !line.startsWith(' ')) {
        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();

        // 去除引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        metadata[key] = value;
      }
    }
    return { metadata, body };
  }
}

/**
 * 获取 Skill 元数据
 * 支持 TTL 缓存,过期自动刷新
 */
export async function getSkillMetadata(skillName: string): Promise<SkillMetadata> {
  const cached = skillMetadataCache.get(skillName);
  
  // 检查缓存是否有效
  if (cached && !isCacheExpired(cached.timestamp)) {
    return cached.data;
  }
  
  // 缓存过期或不存在,重新加载
  console.error(`[SKILL-LOADER] Skill 元数据缓存过期或不存在,重新加载: ${skillName}`);
  const content = await getSkillContent(skillName);
  const { metadata } = await parseFrontmatter(content);

  const metadataObj: SkillMetadata = {
    name: metadata.name || skillName,
    description: metadata.description || `${skillName} skill`,
    constraint: metadata.constraint,
    version: metadata.version,
    tools: metadata.tools || [],
    ...metadata, // 包含其他自定义字段
  };

  skillMetadataCache.set(skillName, { data: metadataObj, timestamp: Date.now() });
  return metadataObj;
}

/**
 * 获取 Skill 所需的工具列表
 * @param skillName Skill 名称
 * @returns 工具列表
 */
export async function getSkillTools(skillName: string): Promise<SkillTool[]> {
  const metadata = await getSkillMetadata(skillName);
  return metadata.tools || [];
}

/**
 * 获取所有 Skills 所需的工具（去重）
 * @returns 所有必需的工具列表
 */
export async function getAllRequiredTools(): Promise<SkillTool[]> {
  const skills = await getAvailableSkills();
  const toolMap = new Map<string, SkillTool>();

  for (const skillName of skills) {
    const tools = await getSkillTools(skillName);
    for (const tool of tools) {
      // 如果工具已存在且当前是必需的，覆盖之前的
      if (!toolMap.has(tool.name) || tool.required) {
        toolMap.set(tool.name, tool);
      }
    }
  }

  return Array.from(toolMap.values());
}

/**
 * 获取所有 skills 的元数据
 */
export async function getAllSkillsMetadata(): Promise<SkillMetadata[]> {
  const skills = await getAvailableSkills();
  return Promise.all(skills.map(skillName => getSkillMetadata(skillName)));
}

/**
 * 获取 CI Skill 内容（兼容旧接口）
 */
export async function getCISkillContent(): Promise<string> {
  return getSkillContent('ci');
}

/**
 * 获取 CD Skill 内容（兼容旧接口）
 */
export async function getCDSkillContent(): Promise<string> {
  return getSkillContent('cd');
}

/**
 * 获取 Skill 目录下文件的绝对路径
 * @param skillName Skill 名称
 * @param filename 文件名（如 'template.yaml'）
 * @returns 绝对路径，如果文件不存在则返回 null
 */
export function getSkillFilePath(skillName: string, filename: string): string | null {
  const skillDir = getSkillsDir();
  const filePath = resolve(skillDir, skillName, filename);
  
  if (existsSync(filePath)) {
    return filePath;
  }
  
  return null;
}

// 全局临时目录路径
let globalTempSkillDir: string | null = null;

/**
 * 设置全局临时 Skill 目录
 */
export function setTempSkillDir(tempDir: string): void {
  globalTempSkillDir = tempDir;
}

/**
 * 获取全局临时 Skill 目录
 */
export function getTempSkillDir(): string | null {
  return globalTempSkillDir;
}

/**
 * 获取指定 Skill 的所有资源文件列表
 * @param skillName Skill 名称
 * @returns 资源文件名列表（不含 SKILL.md）
 */
export function getSkillResourceFiles(skillName: string): string[] {
  if (!globalTempSkillDir) {
    return [];
  }
  
  const skillDir = resolve(globalTempSkillDir, skillName);
  
  if (!existsSync(skillDir)) {
    return [];
  }
  
  try {
    return readdirSync(skillDir)
      .filter(name => name !== 'SKILL.md');
  } catch {
    return [];
  }
}

/**
 * 获取工作区 Skill 资源目录
 * 使用全局临时目录
 */
function getWorkspaceSkillDir(skillName: string): string {
  return resolve(globalTempSkillDir!, skillName);
}

/**
 * 递归复制目录
 */
function copyDirectorySync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 从远程下载单个文件
 * @param url 文件 URL
 * @param targetPath 本地保存路径
 * @returns 是否成功
 */
async function downloadRemoteFile(url: string, targetPath: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    const gitlabToken = process.env.GITLAB_TOKEN;
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      console.error(`[SKILL-LOADER] 下载远程文件失败: ${url} - ${response.status}`);
      return false;
    }
    
    const content = await response.text();
    
    // 检查是否返回了 HTML 页面
    if (content.trim().startsWith('<!DOCTYPE') || content.trim().startsWith('<html')) {
      console.error(`[SKILL-LOADER] 下载远程文件返回了 HTML 页面: ${url}`);
      return false;
    }
    
    // 确保目标目录存在
    mkdirSync(dirname(targetPath), { recursive: true });
    
    // 写入文件
    writeFileSync(targetPath, content, 'utf-8');
    return true;
  } catch (error) {
    console.error(`[SKILL-LOADER] 下载远程文件异常: ${url}`, error);
    return false;
  }
}

/**
 * 获取远程 Skill 目录下的所有文件列表
 * @param skillName Skill 名称
 * @param source 远程源配置
 * @returns 文件列表
 */
async function listRemoteSkillFiles(skillName: string, source: SkillSource): Promise<string[]> {
  try {
    // 解析原始 URL 获取项目信息
    const parsed = await parseGitLabUrl(source.originalUrl);
    if (!parsed) {
      console.error(`[SKILL-LOADER] 无法解析远程 URL: ${source.originalUrl}`);
      return [];
    }
    
    const { host, projectPath, ref, path: basePath } = parsed;
    const skillPath = basePath ? `${basePath}/${skillName}` : skillName;
    
    // 构建 GitLab API URL 获取目录内容
    const encodedProjectPath = encodeURIComponent(projectPath);
    const apiUrl = `${host}/api/v4/projects/${encodedProjectPath}/repository/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(skillPath)}`;
    
    const headers: Record<string, string> = {};
    const gitlabToken = process.env.GITLAB_TOKEN;
    if (gitlabToken) {
      headers['PRIVATE-TOKEN'] = gitlabToken;
    }
    
    const response = await fetch(apiUrl, { headers });
    
    if (!response.ok) {
      console.error(`[SKILL-LOADER] 获取远程文件列表失败: ${response.status}`);
      return [];
    }
    
    const items = await response.json() as Array<{ name: string; type: string }>;
    
    // 过滤掉 SKILL.md，只返回其他文件
    return items
      .filter(item => item.type === 'blob' && item.name !== 'SKILL.md')
      .map(item => item.name);
  } catch (error) {
    console.error(`[SKILL-LOADER] 获取远程文件列表异常:`, error);
    return [];
  }
}

/**
 * 提取远程 Skill 的所有资源到临时目录
 * @param skillName Skill 名称
 * @param source 远程源配置
 * @returns 提取的资源路径列表
 */
async function extractRemoteSkillResourcesToTempDir(skillName: string, source: SkillSource): Promise<string[]> {
  const extractedPaths: string[] = [];
  
  // 获取远程文件列表
  const files = await listRemoteSkillFiles(skillName, source);
  
  if (files.length === 0) {
    console.error(`[SKILL-LOADER] 远程 Skill ${skillName} 没有资源文件`);
    return [];
  }
  
  console.error(`[SKILL-LOADER] 发现远程 Skill ${skillName} 的资源文件: ${files.join(', ')}`);
  
  // 下载每个文件
  for (const fileName of files) {
    const fileUrl = `${source.baseUrl}/${skillName}/${fileName}`;
    const targetDir = getWorkspaceSkillDir(skillName);
    const targetPath = resolve(targetDir, fileName);
    
    const success = await downloadRemoteFile(fileUrl, targetPath);
    if (success) {
      extractedPaths.push(targetPath);
      console.error(`[SKILL-LOADER] 已下载远程资源: ${skillName}/${fileName} -> ${targetPath}`);
    } else {
      console.error(`[SKILL-LOADER] 下载远程资源失败: ${skillName}/${fileName}`);
    }
  }
  
  return extractedPaths;
}

/**
 * 提取 Skill 的所有资源到临时目录（用于初始化时注入）
 * 自动扫描 Skill 目录下的所有文件（除了 SKILL.md），无需 frontmatter 声明
 * 支持本地和远程 Skill
 * @param skillName Skill 名称
 * @returns 提取的资源路径列表
 */
export async function extractSkillResourcesToTempDir(skillName: string): Promise<string[]> {
  const config = getSkillsConfig();
  
  // 如果是远程模式，从远程下载资源
  if (config.source === 'remote') {
    const source = skillSourceMap.get(skillName);
    if (source) {
      console.error(`[SKILL-LOADER] 从远程源 ${source.name} 提取 Skill ${skillName} 的资源`);
      return extractRemoteSkillResourcesToTempDir(skillName, source);
    }
    
    // 如果没有找到映射，尝试使用第一个源
    if (config.sources && config.sources.length > 0) {
      console.error(`[SKILL-LOADER] 使用默认远程源提取 Skill ${skillName} 的资源`);
      return extractRemoteSkillResourcesToTempDir(skillName, config.sources[0]);
    }
    
    console.error(`[SKILL-LOADER] 远程模式下找不到 Skill ${skillName} 的源配置`);
    return [];
  }
  
  // 本地模式：从本地文件系统复制
  const skillDir = getSkillsDir();
  const sourceDir = resolve(skillDir, skillName);
  
  // 检查 Skill 目录是否存在
  if (!existsSync(sourceDir)) {
    console.error(`[SKILL-LOADER] Skill 目录不存在: ${sourceDir}`);
    return [];
  }
  
  const extractedPaths: string[] = [];
  
  try {
    // 读取 Skill 目录下的所有文件和子目录
    const entries = readdirSync(sourceDir, { withFileTypes: true });
    
    for (const entry of entries) {
      // 跳过 SKILL.md 文件（这是主文档，不需要复制）
      if (entry.name === 'SKILL.md') {
        continue;
      }
      
      const sourcePath = resolve(sourceDir, entry.name);
      const targetDir = getWorkspaceSkillDir(skillName);
      const targetPath = resolve(targetDir, entry.name);
      
      try {
        // 确保目标目录存在
        mkdirSync(dirname(targetPath), { recursive: true });
        
        // 复制文件或目录
        if (entry.isDirectory()) {
          copyDirectorySync(sourcePath, targetPath);
        } else {
          copyFileSync(sourcePath, targetPath);
        }
        
        extractedPaths.push(targetPath);
        console.error(`[SKILL-LOADER] 已提取资源: ${skillName}/${entry.name} -> ${targetPath}`);
      } catch (error) {
        console.error(`[SKILL-LOADER] 提取资源失败: ${skillName}/${entry.name}`, error);
      }
    }
  } catch (error) {
    console.error(`[SKILL-LOADER] 读取 Skill 目录失败: ${sourceDir}`, error);
  }
  
  return extractedPaths;
}

/**
 * 提取所有 Skill 的所有资源到指定临时目录
 * @param tempDir 临时目录路径
 * @returns 所有提取的资源路径
 */
export async function extractAllSkillResourcesToTempDir(tempDir: string): Promise<Record<string, string[]>> {
  // 设置全局临时目录
  setTempSkillDir(tempDir);
  
  const skills = await getAvailableSkills();
  const allExtracted: Record<string, string[]> = {};
  
  console.error(`[SKILL-LOADER] 开始提取 ${skills.length} 个 Skill 的资源到临时目录: ${tempDir}`);
  
  for (const skillName of skills) {
    const paths = await extractSkillResourcesToTempDir(skillName);
    if (paths.length > 0) {
      allExtracted[skillName] = paths;
    }
  }
  
  const totalCount = Object.values(allExtracted).flat().length;
  console.error(`[SKILL-LOADER] 资源提取完成，共 ${totalCount} 个文件`);
  
  return allExtracted;
}
