# 发布与更新

本仓库只包含 `dsh-scnet-plan` 插件本身（不含外层工程目录）。

## 1. 首次创建 GitHub 仓库

在 GitHub 上新建一个**空仓库**（不要勾选自动生成 README / .gitignore / LICENSE），例如 `dsh-scnet-plan`，然后：

```bash
cd /path/to/dsh-scnet-plan

# 把 <owner> 换成你的 GitHub 用户名
git remote add origin https://github.com/<owner>/dsh-scnet-plan.git

# 首次推送（本地默认分支为 main）
git push -u origin main
git push origin v0.0.1
```

如果仓库名不是 `dsh-scnet-plan`，把 README、`package.json` 的 `repository`/`homepage`/`bugs` 里的地址一并改掉。

也可以直接用 gh CLI：

```bash
gh repo create <owner>/dsh-scnet-plan --public --source=. --remote=origin --push
git push origin v0.0.1
```

## 2. 发布 Release

```bash
gh release create v0.0.1 \
  --title "dsh-scnet-plan 0.0.1" \
  --notes-file CHANGELOG.md
```

每个版本一个 tag，tag 名与 `package.json` 的 `version` 严格一致（`vX.Y.Z`）。

## 3. 发布新版本

```bash
# 1) 改版本号与变更记录
#    - package.json -> version
#    - CHANGELOG.md 顶部加一节
git add -A
git commit -m "release: 0.0.2"
git tag -a v0.0.2 -m "dsh-scnet-plan 0.0.2"
git push origin main
git push origin v0.0.2
gh release create v0.0.2 --notes-file CHANGELOG.md --title "dsh-scnet-plan 0.0.2"
```

CI（`.github/workflows/ci.yml`）会在 push / PR 时跑测试，发布前确认它是绿的。

## 4. 用户如何更新

```bash
cd dsh-scnet-plan
git pull
```

然后在 DSH 里重新安装一次（会重新链接并热更新）：

```text
plugin_manager remove_bundle   target = dsh-scnet-plan
plugin_manager install_bundle  target = /绝对路径/dsh-scnet-plan
```

最后刷新页面。`client.js` 的改动通常 HMR 即可生效，`index.js`（Host）改动后才需要卸载重装。

## 5. 安装方式对照

| 方式 | target | 适用 |
| --- | --- | --- |
| GitHub 源（推荐） | `github:<owner>/dsh-scnet-plan#v0.0.1` | 免 clone，pnpm 直接拉取 |
| Release 压缩包 | `https://github.com/<owner>/dsh-scnet-plan/releases/download/v0.0.1/dsh-scnet-plan-0.0.1.tgz` | 无 git 也能装 |
| 本地 clone | `/绝对路径/dsh-scnet-plan` | 开发、排错 |
| npm（发布后） | `dsh-scnet-plan` | 最省事，一行 |

> 打 tag 后 `.github/workflows/release.yml` 会自动跑测试、`npm pack` 并把 `.tgz` 上传到 Release；tarball 直链安装依赖这一步。

## 6. 发布到 npm（可选）

当前不在 npm 上。想启用“一行安装”：

1. 注册 npm 账号（若包名 `dsh-scnet-plan` 可用）；
2. 生成 Automation token：npm → Access Tokens → Generate New Token；
3. 在 GitHub 仓库 Settings → Secrets and variables → Actions 新建 `NPM_TOKEN`；
4. 打 tag 后 `release.yml` 会自动 `npm publish --access public`（没有 secret 时会跳过，只发 GitHub Release）。

之后用户可以直接：

```text
plugin_manager install_bundle  target = dsh-scnet-plan
```

**本地发布**也可以（首次需要 `npm login`）。如果遇到 npm 缓存权限报错：

```bash
sudo chown -R 501:20 ~/.npm
```

注意：npm 包名/版本不可复用，发布后要 bump 版本再发。

## 7. 发布前检查清单

- [ ] `npm test` 全绿（当前 36 例）
- [ ] `node --check index.js && node --check client.js`
- [ ] 版本号、CHANGELOG、tag 三处一致
- [ ] 没有提交 `node_modules/`、`.credentials.yaml`、真实 Cookie / API Key
- [ ] 截图（`docs/panel-*.png`）与当前 UI 一致

## 8. 插件市场

插件市场索引不在本仓库，而是维护在独立仓库 [`dsh-plugins-market`](https://github.com/Ronnie-Young/dsh-plugins-market)（DSH format 1）：

- 索引 URL（给用户添加）：
  `https://raw.githubusercontent.com/Ronnie-Young/dsh-plugins-market/main/index.json`
- 市场的「添加索引源」由用户操作，插件/agent 不能代为添加。
- 用户在「发现 → 管理索引源 → 添加索引源」填入 URL，之后就能在市场里看到 `dsh-scnet-plan` 并一键安装。

### 每次发版要更新市场索引

`index.json` 里每个版本写 `source: { type: "git", url, commit }`，`commit` 必须是**40 位完整 SHA**（市场安装就是 `git+https://...#<commit>`）。

发版流程：

1. 本仓库推代码、打 tag；
2. 打开 `dsh-plugins-market`，把新版本条目和 commit SHA 写进 `index.json`；
3. 在 `dsh-plugins-market` 里 `npm run validate` 后提交推送（CI 会再校验一次）。

`engines.dsh` 是兼容的 DSH 版本范围（当前 `>=0.2.1-rc.2`），与本机运行版本保持一致即可。

## 9. 推送超时的备用方案

如果 `git push` 在 22 端口或 HTTPS 上超时，改用 GitHub 的 SSH 443 入口：

```bash
git remote set-url origin ssh://git@ssh.github.com:443/<owner>/dsh-scnet-plan.git
git push origin main
```
