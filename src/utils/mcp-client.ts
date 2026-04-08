#!/usr/bin/env node
/**
 * MCP Client 管理器
 * 用于连接和调用外部 MCP Server（jenkins-mcp, gitlab-mcp）
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * MCP Client 封装
 */
class MCPClientWrapper {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private config: MCPServerConfig;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  /**
   * 连接到 MCP Server
   */
  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
    });

    this.client = new Client(
      {
        name: `proxy-${this.config.name}`,
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    await this.client.connect(this.transport);
  }

  /**
   * 调用工具
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    if (!this.client) {
      throw new Error(`MCP Client ${this.config.name} 未连接`);
    }

    return this.client.callTool({
      name: toolName,
      arguments: args,
    });
  }

  /**
   * 列出可用工具
   */
  async listTools(): Promise<any> {
    if (!this.client) {
      throw new Error(`MCP Client ${this.config.name} 未连接`);
    }

    return this.client.listTools();
  }
}

/**
 * MCP Client 管理器（单例）
 */
class MCPClientManager {
  private clients: Map<string, MCPClientWrapper> = new Map();
  private configs: Map<string, MCPServerConfig> = new Map();

  /**
   * 注册 MCP Server 配置
   */
  registerConfig(name: string, config: MCPServerConfig): void {
    this.configs.set(name, config);
  }

  /**
   * 获取或创建 Client
   */
  async getClient(name: string): Promise<MCPClientWrapper> {
    let client = this.clients.get(name);
    if (!client) {
      const config = this.configs.get(name);
      if (!config) {
        throw new Error(`MCP Server ${name} 未配置`);
      }
      client = new MCPClientWrapper(config);
      await client.connect();
      this.clients.set(name, client);
    }
    return client;
  }

  /**
   * 调用指定 MCP Server 的工具
   */
  async callTool(serverName: string, toolName: string, args: Record<string, any>): Promise<any> {
    const client = await this.getClient(serverName);
    return client.callTool(toolName, args);
  }

  /**
   * 列出指定 MCP Server 的工具
   */
  async listTools(serverName: string): Promise<any> {
    const client = await this.getClient(serverName);
    return client.listTools();
  }
}

// 单例实例
let manager: MCPClientManager | null = null;

export function getMCPClientManager(): MCPClientManager {
  if (!manager) {
    manager = new MCPClientManager();
  }
  return manager;
}

export function resetMCPClientManager(): void {
  manager = null;
}

export { MCPClientManager, MCPClientWrapper };
