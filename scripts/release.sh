#!/bin/bash
set -e

echo "================================"
echo "  npm 发布脚本"
echo "================================"
echo ""

# 1. 检查 git 状态
echo "📦 检查 git 状态..."
if [[ -n $(git status -s) ]]; then
  echo "❌ 工作区有未提交的更改，请先提交代码"
  exit 1
fi
echo "✅ 工作区干净"

# 2. 读取当前版本
VERSION=$(node -p "require('./package.json').version")
echo "📌 当前版本: $VERSION"

# 3. 询问是否确认发布
echo ""
read -p "是否发布 postar-pipe-mcp@$VERSION 到 npm? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ 取消发布"
  exit 0
fi

# 4. 触发 GitHub Actions 发布工作流
echo ""
echo "🚀 触发 GitHub Actions 发布工作流..."
echo "   仓库: zkr-1211/mcp"
echo "   版本: $VERSION"
echo ""

# 使用 GitHub CLI 触发工作流
if command -v gh &> /dev/null; then
  gh workflow run publish.yml \
    --repo zkr-1211/mcp \
    -f version="$VERSION"
  
  echo ""
  echo "✅ 发布工作流已触发！"
  echo "📊 查看进度: https://github.com/zkr-1211/mcp/actions/workflows/publish.yml"
else
  echo "⚠️  未安装 GitHub CLI (gh)"
  echo ""
  echo "请手动触发发布工作流："
  echo "1. 访问: https://github.com/zkr-1211/mcp/actions/workflows/publish.yml"
  echo "2. 点击 'Run workflow'"
  echo "3. 输入版本: $VERSION"
  echo "4. 点击 'Run workflow' 按钮"
  echo ""
  echo "安装 GitHub CLI: brew install gh"
fi

echo ""
echo "================================"
echo "  发布完成！"
echo "================================"
