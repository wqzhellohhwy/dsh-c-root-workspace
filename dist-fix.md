# 已构建产物（安装版）的 EPERM 修复

> 面向**没有源码仓库、只装了发行版**的场景（DSH Desktop / npm 全局 CLI / `C:\dsh-runtime\*` 这类独立 runtime）。
> 源码树的修复见 [`fix.patch`](fix.patch) 与 [README](README.md)。

---

## 1. 为什么还需要这一份

原 `fix.patch` 改的是 **TypeScript 源码**：

- `packages/workspace/workspace/src/index.ts` —— 根目录 `basename` 为空时回退标题
- `packages/host/apiproxy/src/api-proxy.ts` —— `mkdir` 失败时用 `stat` 探测回退

它只在**从源码运行**（`pnpm dsh web` / tsx 直跑）时生效。而发行版把编译后的 JS 打包在别处：

| 形态 | 主程序位置 | 版本示例 |
|---|---|---|
| DSH Desktop（Electron） | `resources/app.asar` | 0.2.0-rc.2 |
| npm 全局 CLI | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` | 0.2.1-alpha.1 |
| 独立 runtime | `C:\dsh-runtime\<ver>\node_modules\@deepseek-ai\dsh` | 0.1.0-rc.7 / 0.2.0-rc.2 / 0.2.1-alpha.1 |

**源码树里的补丁不会随发行版走。** 对安装版必须直接补编译产物。

## 2. 2026-10-07 复核：上游只修了一半

对 `0.2.0-rc.2`、`0.2.1-alpha.1` 两份 npm 包，以及 Desktop 的 `app.asar` 逐段核对：

**① 根目录标题 —— 上游已自行修好** ✅

```js
// @deepseek-ai/dsh-workspace/lib/index.js
function defaultWorkspaceTitle(path, platform = process.platform) {
    const pathApi = platform === "win32" ? win32 : posix;
    return pathApi.basename(path) || pathApi.parse(path).root;   // 根目录回退到盘符根
}
```

`path.basename('C:\')` 是 `''`，于是回退成 `path.parse('C:\').root` = `C:\`，工作区有字、可选中。
（源码补丁回退成"完整规范路径"，结果字符串一致。）

**② `mkdir` EPERM —— 上游仍未修** ❌

```js
// @deepseek-ai/dsh-api-session-controller/lib/index.js
try {
    await mkdir(cwd, { recursive: true });
} catch (error) {
    throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error });
}
```

实测（Node 24 / Windows）：

```
path.basename("C:\\")  = ""
mkdir "C:\\"  -> EPERM: operation not permitted
mkdir "C:/"   -> EPERM: operation not permitted
stat("C:\\").isDirectory() = true
```

也就是说：**未修改的官方发行版同样只能在 `C:\` 里"看"、不能"新建会话"。**

行为差异还体现在：

- **打开已有对话**没问题 —— `ensureSession` 先走 `observeSession`，命中就 `agents.resume()` 返回，**根本不执行 mkdir**；
- **新建对话**必失败 —— 走到 `mkdir(cwd, { recursive: true })` 抛 EPERM，调用方拿到错误。

## 3. 产物级修改

同一处的两份副本都要改（`lib/index.js` 是入口，`lib/types/agent.js` 是模块表用的单文件副本）：

```js
// 改前
} catch (error) {
    throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error });
}

// 改后：只放行「Windows 盘符根 + EPERM」，其余错误照旧抛出
} catch (error) {
    if (error.code !== "EPERM" || !/^[a-z]:[\\/]?$/i.test(cwd)) throw error;
}
```

判定表：

| `cwd` | `error.code` | 结果 |
|---|---|---|
| `C:\` / `C:/` / `D:\` | `EPERM` | 放行（目录确实已存在） |
| `C:\toolong`、`\\server\share`、`/usr/local` | `EPERM` | 抛出 |
| `C:\` | 非 `EPERM`（如 `ENOENT`） | 抛出 |

> 代价：非盘符根场景抛出的不再是被包装过的 `failed to ensure project directory ...`，而是 Node 原始错误。
> 仓库内没有任何代码依赖那句文案，`dsh-agent-loop` 等包只是同样匹配 `error.code`。

## 4. 一键工具

两个自包含脚本（不需要源码树，不需要依赖）：

```bash
# Electron Desktop：直接补 app.asar（默认 dry-run，加 --apply 才写）
node tools/patch-asar.mjs --asar "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar" --apply

# 普通 npm 包目录：补 <dsh 安装目录>/node_modules/@deepseek-ai/dsh-api-session-controller
node tools/patch-package.mjs --anchor "C:\dsh-runtime\0.2.1-alpha.1" --apply
```

### `patch-asar.mjs` 的安全设计

`app.asar` 是一个「头部 JSON + 顺序拼接的文件体」归档，任意改动都可能让后面所有文件的 offset 失效。脚本因此：

1. **等长替换**：写回的字节数与原文**完全相同**（不足处用空格补足），因此**头部所有 offset、size 都不变**；
2. 备份原 `app.asar`（`<name>.orig-<stamp>`）后才写；
3. 只重算被改动条目的 `integrity.hash` / `integrity.blocks`，头部 JSON 长度不变；
4. 写完后重新解析归档并**逐条目字节比对**，只有目标条目允许不同；
5. 可选的语法自检（`node --check`）。

> 注意：Desktop 运行中也能覆盖成功（Electron 打开 asar 时带了 FILE_SHARE_DELETE），
> 但**必须重启 Desktop 才生效**。

### `patch-package.mjs`

普通目录没有等长约束，直接做文本替换，同样先备份 `.bak-<stamp>`，并在替换后校验两份文件都含新分支、不含旧分支。

> 覆盖范围：`0.2.x` 系列（包名 `@deepseek-ai/dsh-api-session-controller`）。
> **`0.1.0-rc.7` 不适用** —— 那个版本的对应代码在旧包 `@deepseek-ai/dsh-host-apiproxy` 里，
> 脚本会明确报 "not found" 而不是静默跳过。需要补老版本时用 `--pkg` 指到该包目录，并先确认其中
> 存在同形状的 `try { await mkdir(cwd, { recursive: true }) } catch (...)` 代码块。

## 5. 验证记录（2026-10-07，本机）

| 项目 | 结果 |
|---|---|
| asar 全文件逐字节比对 | 12967 个条目中**仅 2 个**内容变化，其余 12965 个字节完全一致，零 offset 位移 |
| 头部差异 | 仅那 2 个条目的 integrity 字段 |
| 语法 | 两份改后 JS 均通过 `node --check` |
| 逻辑单测 | 7/7 通过（见上表） |
| 安装后哈希 | `fef6dac5a82c385417501b3336c2861380ec9523fd963511c925b6fd330b9dce` |
| 安装前哈希 | `983ca71114e6dfd353fc79af5a1f9481a250ee64c2a3c757673029b811b23bc2` |

回滚：把备份文件覆盖回原位即可。

## 6. 何时不再需要本补丁

上游把 `mkdir` 分支改成"失败后探测目录是否存在"（即原 `fix.patch` 的做法）并发布之后，
本补丁即可废弃 —— 判定方法：在 `C:\` 工作区里成功新建一次对话。
