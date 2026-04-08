---
name: ci
description: /ci、ci、合并、merge、集成、/ci、创建MR、create MR、代码合并、分支合并、合并代码、合并到dev/test/uat。支持单环境合并、多环境批量合并(dev,test,uat)、代码 Review 模式、合并后自动部署。当用户提到合并代码、集成代码、创建合并请求、合并到某环境、或需要将代码合并到目标分支时使用。
constraint: strict
version: 1.0.0
---

# CI 自动化工作流

> ⚠️ **执行约束(CRITICAL) - 必须遵守**
>
> 1. **必须完整阅读**:在执行任何操作前,必须完整阅读本 Skill 及 `steps.yaml` 的所有内容
> 2. **严格按步骤执行**:必须严格按照 `steps.yaml` 中的步骤顺序执行,严禁跳过任何步骤
> 3. **仅执行定义的操作**:只能执行本 Skill 中明确定义的操作,严禁执行其他未指定的操作
> 4. **验证每一步**:每一步完成后必须验证结果,确认成功后再进行下一步
> 5. **错误处理**:如遇错误必须立即停止执行并报告,严禁擅自绕过或忽略错误
> 6. **禁止假设**:不要假设任何配置或状态,必须通过工具调用来确认
> 7. **顺序执行**:多环境部署时必须按顺序逐个执行,严禁并行处理

> **⚠️ 执行步骤定义已抽取**:
> - 详细执行步骤请参考: `steps.yaml`
> - 本文件保留核心说明和约束,步骤细节以 `steps.yaml` 为准
> - AI 执行时必须**同时读取并严格遵守** `steps.yaml` 中的所有步骤定义

## 说明

本指令用于自动化代码合并流程，通过创建并合并 GitLab MR 将代码从源分支合并到目标分支。支持单环境合并、多环境批量合并，并可选择是否启用代码 Review 模式。

## 变量配置

| 变量 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `ENV` | `dev`/`test`/`uat` | `dev` | 目标环境，支持单环境或逗号分隔的多环境，如 `dev,test` |
| `SOURCE_BRANCH` | `branch:分支名` | 当前分支 | 源分支，使用 `branch:分支名` 格式指定，如 `branch:feature/xxx` |
| `NEED_REVIEW` | `review` | `false` | 是否需要代码 Review（用户指定 review 时设为 true） |
| `NEED_DEPLOY` | `/cd`、`发布`、`部署` | `false` | 是否需要部署（命令中包含这些关键词时设为 true） |


> **参数解析规则**：
> 1. 优先匹配简写：`dev`/`test`/`uat`/`review`
> 2. 匹配 `branch:` 前缀，提取分支名作为 `SOURCE_BRANCH`
> 3. 若包含 `=` 则按 `KEY=VALUE` 解析
> 4. **多环境支持**：环境参数支持逗号分隔，如 `dev,test` 表示依次合并到 dev 和 test 环境
> 5. **部署关键词检测**：若命令中包含 `/cd`、`发布`、`部署` 关键词，设置 `NEED_DEPLOY=true`

### 环境对应分支

分支配置从项目根目录的 `config.yaml` 中读取，支持以下占位符：

| ENV | PERSONAL_BRANCH | TARGET_BRANCH | 说明 |
|-----|-----------------|---------------|------|
| `dev` | `{personal_branch_dev}` | `{target_branch_dev}` | 开发环境 |
| `test` | `{personal_branch_test}` | `{target_branch_test}` | 测试环境 |
| `uat` | `{personal_branch_uat}` | `{target_branch_uat}` | UAT环境 |

> **注意**：如果某环境的 `PERSONAL_BRANCH` 未配置（为空），则跳过步骤 2，直接执行 SOURCE_BRANCH → TARGET_BRANCH 的合并。

## 公共逻辑定义

### 0. 分支存在性检查逻辑

创建 MR 前执行：
- 调用 `mcp_gitlab_browse_refs` (action=get_branch, project_id={project_id}, branch={目标分支})
- **必需参数**：
  - `action`: "get_branch"
  - `project_id`: 项目 ID 或 URL 编码路径（如 "zhangkr/ai-test"）
  - `branch`: 分支名称
- 如果返回 404 或分支不存在：**立即停止执行**，输出：
  ```
  ❌ 目标分支不存在：{目标分支}
  请先创建分支 {目标分支} 后重试
  ```

### 1. MR 状态检查逻辑

**方法A: 通过 manage_merge_request 查询 MR 状态（推荐 - 已知 IID 时）**
1. 执行 `mcp_gitlab_manage_merge_request` (action=update, project_id={project_id}, merge_request_iid={iid}, source_branch={source_branch}, target_branch={target_branch})
   - **不传 `state_event` 参数**,仅用于查询
2. 从返回的 MR 对象中读取:
   - `state`: MR 状态（"opened"/"merged"/"closed"）
   - `merge_status`: 合并状态（"can_be_merged"/"cannot_be_merged"）
   - `diff_refs.base_sha` 和 `diff_refs.head_sha`: 用于判断是否有实际变更
   - `web_url`: MR 页面链接
   - `sha`: MR 最新的 head commit SHA

**方法B: 通过 browse_merge_requests 查询 MR 列表（搜索/筛选场景）**
- **适用场景**:
  - 409 冲突时查找已存在的 MR
  - 需要按条件筛选 MR（状态、标签、分支等）
  - 批量查询多个 MR
- **使用示例**: `mcp_gitlab_browse_merge_requests` (action=list, source_branch={source_branch}, target_branch={target_branch}, state=opened, per_page=20)
- **✅ MCP Proxy 已启用 schema 驱动的类型转换**,`per_page`/`page` 等参数会自动处理

检查 `merge_status` 字段:
- 如果为 `cannot_be_merged`:
  1. **检查是否为无文件变更的情况**:比较 `diff_refs.base_sha` 和 `diff_refs.head_sha`
     - 如果两者相同（无实际文件变更）:
       - 执行【关闭 MR 逻辑】
       - 输出提示信息:
         ```
         ℹ️ MR 无文件变更（已合并过），自动关闭
         MR 链接: {web_url}
         ```
       - **继续执行后续步骤**（视为合并成功）
     - 如果两者不同（存在实际冲突）:
       - **立即停止执行**，输出:
         ```
         ❌ MR 创建失败：{source_branch} → {target_branch} 存在冲突，无法自动合并
         MR 链接: {web_url}
         请手动解决冲突后重试
         ```

### 2. Review 检查逻辑

当 `NEED_REVIEW` 为 `true` 或用户明确要求 review 时：
1. **以可点击的 Markdown 链接格式输出 MR 链接**：`[点击查看 MR]({web_url})`
2. **等待用户确认**：提示用户 "请 Review 代码，确认无误后回复 '继续' 或 '确认合并' 以执行自动合并"
3. **停止自动执行**：等待用户回复后再继续

### 3. MR 合并逻辑

执行【合并 MR 工具】
- **⚠️ 关键参数**：`merge_when_pipeline_succeeds` **必须设置为 `true`**，严禁设置为 `false`
  - `true`：允许 GitLab 在流水线通过后自动合并（即使没有流水线也会立即合并）
  - `false`：可能导致合并失败，GitLab 会拒绝执行合并操作
- 如果失败（如 405 错误）：**立即停止执行**，输出：
  ```
  ❌ MR 合并失败：{error_message}
  MR 链接: {web_url}
  请检查 MR 状态后手动处理
  ```

### 4. 关闭 MR 逻辑

执行 `mcp_gitlab_manage_merge_request` (action=update, project_id={project_id}, merge_request_iid={iid}, source_branch={source_branch}, target_branch={target_branch}, state_event=close)
- **必需参数**：
  - `action`: "update"
  - `project_id`: 项目 ID 或 URL 编码路径
  - `merge_request_iid`: MR 的内部 ID
  - `source_branch`: 源分支名称
  - `target_branch`: 目标分支名称
  - `state_event`: "close"

## 执行流程

### 步骤 1: 获取分支信息

> **⚠️ 配置读取优先级**：按以下顺序读取配置，找到即停止：
> 1. 项目根目录的 `config.yaml`
> 2. 默认模版配置（Skill 目录下的 `template.yaml`）
>
> **必须每次重新读取**：禁止使用上下文缓存，每次执行 `/ci` 时都要重新读取配置。

**配置读取逻辑**：
1. 首先尝试读取项目根目录的 `config.yaml`（使用 `read_file` 工具）
2. 若 `config.yaml` 不存在或读取失败，则读取 Skill 目录下的默认配置 `template.yaml`
   - 使用 `read_file` 工具读取 Skill 目录下的 `template.yaml` 文件
3. 合并配置：以读取到的配置为基础，缺失的值使用 `template.yaml` 中的默认值补充

1. **解析 SOURCE_BRANCH（源分支）和项目路径**：
   - 若用户传入了 `branch:分支名`，直接使用该分支作为 SOURCE_BRANCH
   - 若 `config.yaml` 中配置了 `projects.url`，从 URL 中解析项目路径
   - **若以上两者都未满足**，合并执行以下命令（一次终端调用获取全部信息）：
     执行 `git branch --show-current && git remote get-url origin`，解析项目路径
     - 第一行输出作为 SOURCE_BRANCH
     - 第二行输出解析为项目路径

2. **解析其他配置**：
   - **ENV**：若用户传入了 `dev`、`test` 或 `uat`，则使用传入值；否则默认 `dev`
     - **多环境支持**：支持逗号分隔的多环境，如 `dev,test`、`test,uat` 或 `dev,test,uat`
     - 多环境模式下，按顺序依次执行每个环境的合并流程
   - **PERSONAL_BRANCH / TARGET_BRANCH**：从 `config.yaml` 中根据 ENV 提取对应值

### 步骤 2: 创建并合并 MR {SOURCE_BRANCH} 到 {PERSONAL_BRANCH}

> **⚠️ 详细步骤**: 请参考 `steps.yaml` 步骤 2

> **条件判断**:满足以下任一条件时**跳过本步骤**,直接进入步骤 3:
> 1. `PERSONAL_BRANCH` 未配置(为空)
> 2. `SOURCE_BRANCH` 与 `PERSONAL_BRANCH` 相同(当前分支就是中转分支,无需自我合并)

**核心流程**:
1. 执行【分支存在性检查逻辑】(目标分支: {PERSONAL_BRANCH})
2. 创建 MR,记录返回的 MR IID
3. 执行【MR 状态检查】
4. 执行【Review 检查逻辑】(如果启用 Review 模式)
5. 执行【MR 合并逻辑】

### 步骤 3: 创建并合并 MR 到 {TARGET_BRANCH}

> **⚠️ 详细步骤**: 请参考 `steps.yaml` 步骤 3

> **source_branch 取值**：
> - 如果步骤 2 已执行（`PERSONAL_BRANCH` 已配置且 `SOURCE_BRANCH ≠ PERSONAL_BRANCH`）：使用 `{PERSONAL_BRANCH}`
> - 如果步骤 2 被跳过（`PERSONAL_BRANCH` 未配置，或 `SOURCE_BRANCH === PERSONAL_BRANCH`）：使用 `{SOURCE_BRANCH}`

**核心流程**：
1. 执行【分支存在性检查逻辑】（目标分支：{TARGET_BRANCH}）
2. 创建 MR，记录返回的 MR IID
   - ⚠️ 如果 MR 已存在（409 错误），参考 `steps.yaml` 步骤 3.2 的 409 处理流程
3. 执行【MR 状态检查逻辑】
4. 执行【Review 检查逻辑】（如果启用 Review 模式）
5. 执行【MR 合并逻辑】
   - ⚠️ 必需参数：`source_branch`、`target_branch`、`merge_request_iid` (string)、`merge_when_pipeline_succeeds`
   - ⚠️ 关键约束：`merge_when_pipeline_succeeds` **必须为 `true`**，设置为 `false` 会导致合并失败

### 步骤 4: 验证与完成

> **⚠️ 详细步骤**: 请参考 `steps.yaml` 步骤 4

#### 单环境模式
- 确认 MR 状态为 merged
- 确认 {TARGET_BRANCH} 分支已更新
- 输出 CI 完成信息(Markdown 表格格式)

#### 多环境模式
- 按环境顺序依次执行步骤 2 和步骤 3
- 每个环境独立执行完整的合并流程
- 前一个环境合并成功后，继续下一个环境
- 任一环境合并失败，立即停止执行

### 步骤 5: 执行 CD 部署（可选）

> **⚠️ 详细步骤**: 请参考 `steps.yaml` 步骤 5

> **条件判断**：当 `NEED_DEPLOY=true`（命令中包含 `/cd`、`发布`、`部署` 关键词）时执行此步骤。

**核心流程**：
1. **触发 CD 部署流程**：
   - 进入 CD 部署流程，按照 CD skill 规范执行
   - 读取 CD skill 文档了解部署规范（如果可用）
   - 若无法读取，使用内置的 CD 部署逻辑

2. **按照 CD 规范执行部署**：
   - 验证 Jenkins MCP 可用性
   - 读取 `config.yaml` 中的 Jenkins 配置
   - 解析环境和分支信息
   - 处理参数交互（如 BUILD_NAME 为空时需要用户选择）
   - 按环境顺序逐个触发 Jenkins 构建

3. **收集部署结果**：
   - 记录每个环境的队列 ID
   - 记录构建链接
   - 返回给 CI 流程用于最终汇总

**⚠️ 关键原则**：
- ✅ 这是**进入 CD 部署流程**，不是直接调用工具
- ✅ 按照 CD skill 的规范**逐步执行**
- ✅ 多环境部署时按顺序逐个执行
- ✅ 需要交互时必须**暂停等待用户确认**
- ✅ 部署完成后返回结果给 CI 流程

### 步骤 6: 输出最终汇总

> **⚠️ 详细步骤**: 请参考 `steps.yaml` 步骤 6

**⚠️ 输出格式要求**：所有涉及信息汇总的输出必须使用 **Markdown 表格**格式,严禁使用 plaintext 或列表格式。

**仅 CI 模式**（NEED_DEPLOY=false）：输出合并汇总表格

**CI+CD 模式**（NEED_DEPLOY=true）：输出合并汇总表格 + 部署汇总表格

## 使用示例

### 单环境流程（默认）

```
/ci                           # 默认 dev 环境，使用当前分支作为 SOURCE_BRANCH
/ci dev                       # 指定 dev 环境（简写）
/ci ENV=dev                   # 指定 dev 环境（完整写法）
/ci test review               # test 环境 + 需要 Review
/ci branch:feature/xxx          # 指定源分支为 feature/xxx
/ci test branch:bugfix/123      # test 环境 + 指定源分支
```

执行：SOURCE_BRANCH → PERSONAL_BRANCH → TARGET_BRANCH

### CI + CD 一体化流程

```
/ci dev,test 发布                 # 合并到 dev 和 test，并部署
/ci dev /cd                        # 合并到 dev，并部署
/ci dev,test 并且发布到dev和test    # 合并到 dev 和 test，并部署
```

执行流程：
1. CI: SOURCE_BRANCH → dev:TARGET_BRANCH → test:TARGET_BRANCH
2. CD: 触发 dev 和 test 环境的 Jenkins 构建

### 多环境批量合并

```
/ci dev,test                    # 依次合并到 dev 和 test 环境
/ci test,uat                    # 依次合并到 test 和 uat 环境
/ci dev,test,uat                # 依次合并到 dev、test 和 uat 环境
/ci dev,test review             # 多环境合并 + 需要 Review
/ci dev,test branch:feature/xxx # 多环境合并 + 指定源分支
```

执行流程：
1. SOURCE_BRANCH → dev:PERSONAL_BRANCH → dev:TARGET_BRANCH
2. SOURCE_BRANCH → test:PERSONAL_BRANCH → test:TARGET_BRANCH

> **简写规则**：
> - `dev`/`test`/`uat` 直接指定环境，支持逗号分隔多环境
> - `review` 等价于 `NEED_REVIEW=true`
> - `branch:分支名` 指定 `SOURCE_BRANCH`
> - **多环境顺序**：按参数中指定的顺序依次执行，如 `test,dev` 会先合并到 test 再合并到 dev

## 与 `/cd` 命令的关系

| 命令 | 职责 | 使用场景 |
|------|------|----------|
| `/ci` | 代码合并（可选部署） | 需要合并代码到目标分支 |
| `/cd` | 部署触发（Jenkins 构建） | 仅需部署，无需合并 |
| `/ci ... 发布` | 合并 + 部署一体化 | 合并后立即部署 |

**典型工作流**：
```bash
# 方式1：分步执行
/ci dev          # 合并代码
/cd dev          # 部署服务

# 方式2：一体化执行
/ci dev 发布      # 合并 + 部署一步完成
```

---

## 附录：工具参数参考

### 公共工具定义

以下工具在多个步骤中被复用，统一在此定义：

#### 【管理 MR 工具】
`mcp_gitlab_manage_merge_request` - 管理 MR（创建、查询、更新、合并）

**创建 MR**：
- `action`: "create"
- `project_id`: 项目 ID 或 URL 编码路径
- `source_branch`: 源分支名称
- `target_branch`: 目标分支名称
- `title`: MR 标题
- `description`: MR 描述（可选）

**查询 MR 状态**（推荐方式）：
- `action`: "update"
- `project_id`: 项目 ID 或 URL 编码路径
- `merge_request_iid`: MR 内部 ID (string)
- `source_branch`: 源分支名称
- `target_branch`: 目标分支名称
- **注意**: 不传 `state_event` 参数,仅用于查询

**合并 MR**：
- `action`: "merge"
- `project_id`: 项目 ID 或 URL 编码路径
- `merge_request_iid`: MR 内部 ID (string)
- `source_branch`: 源分支名称（必需）
- `target_branch`: 目标分支名称（必需）
- `merge_when_pipeline_succeeds`: **true（必须）** ⚠️ 严禁设置为 false，否则会导致合并失败

**关闭 MR**：
- `action`: "update"
- `project_id`: 项目 ID 或 URL 编码路径
- `merge_request_iid`: MR 内部 ID (string)
- `source_branch`: 源分支名称
- `target_branch`: 目标分支名称
- `state_event`: "close"

---

### GitLab 工具详情

#### 1. mcp_gitlab_browse_refs
查询分支信息。

**参数**：
| 参数名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| `action` | string | ✅ | 固定值 "get_branch" |
| `project_id` | string | ✅ | 项目 ID 或 URL 编码路径（如 "zhangkr/ai-test"） |
| `branch` | string | ✅ | 分支名称 |

**响应字段**：
| 字段名 | 说明 |
|--------|------|
| `name` | 分支名称 |
| `commit.id` | 最新提交 SHA |
| `commit.title` | 最新提交标题 |
| `merged` | 是否已合并 |
| `protected` | 是否受保护 |

#### 2. mcp_gitlab_manage_merge_request
管理 MR（创建、查询、更新、合并）。详见【管理 MR 工具】定义。

**⚠️ 这是唯一允许使用的 MR 管理工具**，支持以下操作：
- `action: create` - 创建 MR
- `action: update` - 更新 MR（不传 `state_event` 时用于查询）
- `action: merge` - 合并 MR
- `action: update` + `state_event: close` - 关闭 MR

#### 3. mcp_gitlab_browse_merge_requests（搜索/筛选场景）

> **✅ 完全可用**
> 
> MCP Proxy 已启用 **schema 驱动的类型转换**，所有参数类型会自动根据 schema 定义处理
> 
> **适用场景**：
> - 409 冲突时查找已存在的 MR（**首选方法**）
> - 搜索/筛选 MR 列表
> - 按状态、标签、分支过滤 MR
> - 批量查询多个 MR
> 
> **常用参数**：
> | 参数名 | 类型 | 说明 |
> |--------|------|------|
> | `action` | string | 固定值 "list" |
> | `project_id` | string | 项目 ID 或路径 |
> | `source_branch` | string | 源分支名称 |
> | `target_branch` | string | 目标分支名称 |
> | `state` | string | MR 状态（opened/merged/closed） |
> | `per_page` | number | 每页数量（**自动转换**） |
> | `page` | number | 页码（**自动转换**） |
> 
> **使用示例**：
> ```
> # 查找 opened 状态的 MR
> action: list
> source_branch: feature/xxx
> target_branch: develop
> state: opened
> per_page: 10
> ```

### Jenkins 工具

#### mcp_{jenkins_name}_build_item
触发 Jenkins 构建。

**参数**：
| 参数名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| `fullname` | string | ✅ | Jenkins Job 全名 |
| `build_type` | string | ✅ | 固定值 "buildWithParameters" |
| `params` | object | ✅ | 构建参数对象（如 `{BUILD_NAME: "build:dev:api"}`） |

**响应**：
- 成功：返回队列 ID（number，如 107941）
- 失败：返回错误信息

#### mcp_{jenkins_name}_get_all_items
获取所有 Jenkins Jobs（用于可用性验证）。

**参数**：
| 参数名 | 类型 | 必需 | 说明 |
|--------|------|------|------|
| `random_string` | string | ✅ | 任意字符串（如 "check"） |

**响应**：
- 成功：返回 Job 列表数组
- 失败：返回错误信息
