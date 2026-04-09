/**
 * Cloudflare Worker - 代理 GitHub Release 下载
 * 免费套餐：每天 10 万次请求，国内有节点加速
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 只处理 /{version}/{filename} 格式的请求
    const match = pathname.match(/^\/v?([\d.]+)\/(.+)$/);
    if (!match) {
      return new Response('Not Found', { status: 404 });
    }

    const [, version, filename] = match;
    
    // 构建 GitHub Release 下载 URL
    const githubUrl = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/download/v${version}/${filename}`;

    // 直接代理请求（保持二进制流）
    const response = await fetch(githubUrl, {
      method: request.method,
      headers: request.headers,
      redirect: 'follow',
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  },
};
