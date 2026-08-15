# dsh-c-root-workspace

DeepSeek Harness（DSH）**C 盘根目录作为工作区**修复方案。解决 Windows 上无法以 `C:\` 为工作区创建/选中会话的两个根因（空标题 + `mkdir` EPERM），附带单元测试与一键补丁。

## 项目背景

DSH 的 Web UI 支持选择任意目录作为工作区，但选择 `C:\`（文件系统根目录）时出现两个问题：

1. **工作区没有名称，无法选中**：工作区标题默认取自路径 `basename`，而 Windows 上 `path.basename('C:\\')` 返回空字符串 `''` → 前端列表只渲染文件夹图标、没有文字标签 → 点击无效。
2. **一选中就切换回 Program Files**：在 `C:\` 新建会话时 `fs.mkdir('C:\\', { recursive: true })` 在 Windows 上抛 **EPERM**（即使 `recursive` 也无法对已存在的根目录执行）→ 会话创建失败 → 选中状态回退到原工作区。

实测路径（`C:\Users\53518\deepseek-harness`，Node v24.18.1 + pnpm 11.7.0）：
- `C:\` 工作区记录被创建时 `title` 为空字符串
- 在 `C:\` 内新建会话必现 EPERM，普通目录（如 `C:\Program Files` 下的子目录）正常

## 核心功能

- **根目录标题回退**：`WorkspaceRegistry` 两处 `basename` 用法增加空值回退——当 `basename` 为空（文件系统根目录）时改用完整规范路径作为显示标题，保证工作区始终有可显示的标签。
- **根目录 mkdir EPERM 兼容**：`ensureSession` 的 `mkdir(cwd, { recursive: true })` 失败时先探测目录是否已存在（`stat().isDirectory()`），已存在则视为满足"确保项目目录"契约，不再抛错中断会话创建。
- **单元测试覆盖**：新增 `workspace.spec.ts` 根目录标题回退测试；新增 `api-proxy-root-dir.spec.ts` 用 mock 强制 `mkdir` 抛 EPERM，证明 stat 探测回退（而非 mkdir 本身）满足了契约，且目录不存在时仍会响亮失败。

## 技术栈

| 组件 | 说明 |
| --- | --- |
| TypeScript | 修复涉及的源码语言 |
| Cordis | DSH 插件架构（`WorkspaceRegistry` / `createApiProxy` 均为 Cordis 插件服务） |
| Node.js | ≥ 22.19（DSH 要求 `^22.19.0 \|\| >=24.0.0`），运行与测试环境 |
| pnpm | 11.x，monorepo 包管理 |
| vitest | 单元测试框架（仓库根或包目录运行） |
| tsx | 开发模式源码直跑（`node --import tsx/esm`），修复后无需重新构建即可生效 |

## 快速开始指南

### 1. 环境要求

- Windows 10/11（问题本身源于 Windows 文件系统根目录语义）
- 已安装 DSH 仓库（如 `C:\Users\53518\deepseek-harness`）且 `pnpm install` 完成

### 2. 应用补丁（二选一）

方式 A（推荐）：在 DSH 仓库根目录执行

```
cd C:\Users\53518\deepseek-harness
git apply C:\Users\53518\Documents\Qoder\2026-08-14\chat-4\dsh-c-root-workspace\fix.patch
```

方式 B（手动）：按 [fix.patch](fix.patch) 逐文件修改：

| 文件 | 修改 |
| --- | --- |
| `packages/workspace/workspace/src/index.ts` | 2 处 `basename(...)` 增加 `\|\| canonical` / `\|\| group.path` 回退 |
| `packages/workspace/workspace/src/types.ts` | `title` 字段注释同步说明回退行为 |
| `packages/host/apiproxy/src/api-proxy.ts` | `ensureSession` 的 mkdir 失败分支增加 `stat` 探测回退 |
| `packages/workspace/workspace/tests/workspace.spec.ts` | 新增根目录标题回退测试用例 |
| `tests/api-proxy-root-dir.spec.ts`（新增） | 复制到 `packages/host/apiproxy/tests/` 下 |

### 3. 运行测试

```
cd C:\Users\53518\deepseek-harness
pnpm vitest run packages/workspace/workspace/tests/workspace.spec.ts
pnpm vitest run packages/host/apiproxy/tests/api-proxy-root-dir.spec.ts
```

全部通过（44 个既有用例 + 新增用例）即修复生效。

## 使用方法

1. 启动 DSH Web：`pnpm dsh web`（开发模式用 tsx 直跑源码，**无需重新构建**，重启服务即生效）
2. 打开 http://127.0.0.1:3080，选择 `C:\` 作为工作区
3. 预期行为：
   - 工作区列表显示 `C:\` 标题（此前只有文件夹图标、无文字）
   - 选中 `C:\` 后停留于该工作区（此前自动切换回 Program Files）
   - 在 `C:\` 内新建会话成功（此前 EPERM 失败）

实测结果（2026-08-14）：`workspace.json` 中 `C:\` 记录 title 为 `C:\`，sessionIds 正常累积（含 `session-5a6cbc39` 等 7 个会话）。

## 项目结构

```
dsh-c-root-workspace/
├── README.md          # 本文档
├── fix.patch          # 完整补丁（git apply 一键应用，4 文件修改 + 1 新增测试）
└── tests/
    └── api-proxy-root-dir.spec.ts   # 新增测试文件副本
```

> 修复已实际应用于 `C:\Users\53518\deepseek-harness`；本仓库保留补丁与测试供追溯/复现。

## 常见问题

Q：`git apply` 报错？
A：确认 DSH 仓库无冲突修改；或改用手动方式逐文件修改。

Q：修复后 C 盘根目录工作区仍无法选中？
A：确认服务已重启（`pnpm dsh web` 直跑源码无需构建；若用 `node apps/cli/lib/bin.js web` 快速路径需先 `pnpm run build:lib`）。

Q：`C:\` 之外的根目录（如 `D:\`）也适用吗？
A：适用。修复按 basename 为空/根目录 EPERM 通用语义处理，不限于 C 盘。

## 版本历史

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.1.0 | 2026-08-14 | 初始修复：根目录标题回退 + mkdir EPERM 兼容 + 测试 |

## 许可证

补丁与测试随 DSH 项目同源（MIT）。DSH 本体遵循其仓库 LICENSE（MIT）。
