# dsh-doctor

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装做一次一条命令的体检。

DSH 出问题时，有用的事实散落在 home 目录里：这次启动的是哪个 profile、`dsh.profile.bundles` 里的每个 bundle 是否还能解析、`link:` 依赖是否指向了已经搬走的目录、patch 层还能不能解析、磁盘还剩多少。`dsh_doctor` 只读地收集这些事实，输出一份脱敏的 Markdown 报告，可以直接贴进 Discussion。

## 安装

```sh
dsh plugin --profile <name> add github:Bliveren/dsh-doctor
```

包是纯 ESM，没有构建步骤，所以从 git 安装不需要 build 脚本白名单。建议固定提交（`github:Bliveren/dsh-doctor#<sha>`），避免之后一次推送改变实际运行的代码。

重启宿主后对模型说：

> 运行 dsh_doctor，把报告发我。

## 检查项

| 检查 | 回答的问题 |
|---|---|
| `runtime/node` | 当前 Node.js 是否在支持范围内 |
| `profile/exists` | 启动的 profile 目录是否存在 |
| `profile/manifest` | manifest 里是否有可读的 `dsh.profile.bundles` |
| `bundle/<name>` | 每个 bundle：是 in-box 还是已安装、patch 文件是否存在、`engines.dsh` 是否满足 |
| `profile/patch` | `cordis.patch.yml` 能否解析、是否有重复的 row id |
| `profile/local-links` | `link:` / `file:` 依赖指向的目标还在不在 |
| `profile/backups` | 遗留的 `.bak-*` 文件与被放弃的 `<profile>.broken-*` 副本 |
| `profile/lockfile` | profile 依赖是否被锁定 |
| `home/exists`、`home/writable` | DSH home 是否存在、是否可写 |
| `home/disk` | DSH home 所在卷的剩余空间 |
| `home/credentials` | `.credentials.yaml` 是否存在、权限是否收紧 |

in-box bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 等）从 dsh 安装本身解析，不会出现在 profile 的 `node_modules` 里，所以它们的缺席不是问题。判据是：profile manifest 的 `dependencies` 里没有列出它。

## 参数

- `profile` —— 要检查的 profile 名。默认取宿主启动时的 profile，从启动参数里的 profile 目录路径或 `DSH_PROFILE` 识别。

## 报告示例

```markdown
# DSH Doctor report

- generated: 2026-11-01T15:09:33.084Z
- platform: darwin arm64
- node: v24.21.0
- dsh home: `~/.dsh`
- profile: `desktop`
- summary: 13 pass, 1 warn, 0 fail, 0 skip

| Check | Status | Detail |
|---|---|---|
| runtime/node | PASS | v24.21.0 satisfies >=24.9. |
| profile/manifest | PASS | 3 bundle(s): @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, @local/computer-use. |
| profile/backups | WARN | 4 backup file(s) such as package.json.before-persona-fix-…; abandoned profile desktop.broken-20261031-102652 (last change 2026-10-31). |
```

## 它不做什么

- 不读取凭据内容，只报告是否存在和权限位。
- 不写入、不修复、不删除任何东西；修复建议以 hint 形式给出。
- 通过不等于“装好了一定能用”。这些检查覆盖的是层组合与文件系统状态；运行时行为（供应商可达性、沙箱可用性、插件内部状态）不在本工具范围内。

## 开发

```sh
pnpm install
pnpm test
```

检查逻辑在 `lib/checks.js`，是对路径与进程事实的纯函数，因此新增检查不用启动 DSH 就能测试；`index.js` 只负责把它们接到工具注册表。

MIT 许可。
