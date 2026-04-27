/**
 * Batch Executor - 批量工具调用编排器
 * 支持将多个 MCP 工具调用组合为一次调用，减少 AI 与 MCP 之间的往返次数。
 * 同 parallel_group 的步骤并发执行，不同组顺序执行。
 */
import { handleProxiedTool } from './tool-proxy.js';

export interface BatchStep {
  /** 工具名称（如 mcp_jenkins_get_item、mcp_gitlab_browse_refs） */
  tool: string;
  /** 工具参数 */
  args?: Record<string, any>;
  /** 并行分组编号，同组步骤并发执行，不同组按组号升序顺序执行（默认 0） */
  parallel_group?: number;
}

export interface BatchResult {
  /** 工具名称 */
  tool: string;
  /** 执行状态 */
  status: 'success' | 'error';
  /** 成功时的返回结果 */
  result?: any;
  /** 失败时的错误信息 */
  error?: string;
}

/**
 * 执行单个步骤
 */
async function runStep(step: BatchStep): Promise<BatchResult> {
  try {
    const result = await handleProxiedTool(step.tool, step.args || {});
    return { tool: step.tool, status: 'success', result };
  } catch (error: any) {
    return { tool: step.tool, status: 'error', error: error.message };
  }
}

/**
 * 执行批量步骤
 *
 * 分组策略：
 * - 按 parallel_group 分组，组号升序排序
 * - 同组步骤：Promise.all 并发执行
 * - 不同组：顺序执行（前一组全部完成后才执行下一组）
 * - 任一步骤失败不阻断其他步骤执行，错误信息记录在对应结果中
 */
export async function executeBatch(steps: BatchStep[]): Promise<BatchResult[]> {
  if (!steps || steps.length === 0) {
    return [];
  }

  // 1. 按 parallel_group 分组
  const groups = new Map<number, BatchStep[]>();
  for (const step of steps) {
    const group = step.parallel_group ?? 0;
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group)!.push(step);
  }

  // 2. 按组号升序执行
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a - b);
  const allResults: BatchResult[] = [];

  for (const [, groupSteps] of sortedGroups) {
    if (groupSteps.length === 1) {
      // 单步骤直接执行
      const result = await runStep(groupSteps[0]);
      allResults.push(result);
    } else {
      // 多步骤并发执行
      const results = await Promise.all(groupSteps.map((s) => runStep(s)));
      allResults.push(...results);
    }
  }

  return allResults;
}

/**
 * 将 BatchResult 数组格式化为可读的文本输出
 */
export function formatBatchResults(results: BatchResult[]): string {
  const lines: string[] = [];
  const successCount = results.filter((r) => r.status === 'success').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  lines.push(`Batch Execute 完成: ${results.length} 步骤, ${successCount} 成功, ${errorCount} 失败`);
  lines.push('');

  // 汇总表格
  lines.push('| # | 工具 | 状态 | 结果摘要 |');
  lines.push('|---|------|------|----------|');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const statusIcon = r.status === 'success' ? 'success' : 'error';
    const summary = r.status === 'success'
      ? truncateResult(r.result)
      : r.error || '未知错误';
    lines.push(`| ${i + 1} | \`${r.tool}\` | ${statusIcon} | ${summary} |`);
  }

  // 详细结果
  lines.push('');
  lines.push('---');
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`### 步骤 ${i + 1}: ${r.tool}`);
    lines.push('');
    lines.push(`- **状态**: ${r.status === 'success' ? 'success' : 'error'}`);
    if (r.status === 'success') {
      const text = formatResultDetail(r.result);
      lines.push(`- **结果**:`);
      lines.push('```json');
      lines.push(text);
      lines.push('```');
    } else {
      lines.push(`- **错误**: ${r.error}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 截断结果摘要（避免输出过长）
 */
function truncateResult(result: any, maxLen = 120): string {
  if (result === null || result === undefined) return 'null';
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
  } catch {
    return String(result).substring(0, maxLen);
  }
}

/**
 * 格式化详细结果
 */
function formatResultDetail(result: any): string {
  if (result === null || result === undefined) return 'null';
  try {
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
