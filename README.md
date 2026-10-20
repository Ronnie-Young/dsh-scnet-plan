# dsh-scnet-plan

DeepSeek Harness 插件：在 DSH 里直接查看 **SCNet（超算互联网）Token Plan** 的月度 Credits 额度、每日消耗与 token 构成。

装上之后：

- **侧栏面板**：剩余比例圆环（绿/琥珀/红）、Credits 明细、今日/日均消耗、每日热力图、可用模型、明细账单入口；
- **设置页**：手机验证码或账号密码登录一次即可，**不用复制 Cookie、不用开开发者工具**；
- **输入框徽标**：对话框输入框下方常驻剩余百分比；
- **模型工具 `get_scnet_plan`**：直接问「我还剩多少额度」时，模型能自己读出来。

| 浅色 | 深色 |
| --- | --- |
| ![面板浅色](docs/panel-after.png) | ![面板深色](docs/panel-after-dark.png) |

> SCNet Token Plan 的额度单位是 **Credits**（按月），官方四档：基础版 60,000 / 标准版 240,000 / 高级版 600,000 / 旗舰版 1,800,000。

## 为什么需要登录

SCNet 的额度接口只认**控制台登录态**，API Key（`sk-tp-…`）只能列模型，读不到额度：

| 数据 | 接口 | 鉴权 |
| --- | --- | --- |
| 模型列表 | `GET {api}/api/llm/v1/models` | `Bearer sk-tp-…` |
| 套餐目录 | `GET {console}/acx/llm/api/package/overview?packageType=TokenPlan` | 无需鉴权 |
| **当前订阅额度与消耗** | `GET {console}/acx/charge/account/currentuser/tokenplan/list` | **控制台会话 Cookie** |
| **每日 Credits + token** | `POST {console}/acx/charge/consume-query/resource-usage` | **控制台会话 Cookie** |

插件在 Host 侧（Node，不在浏览器里）用 SCNet 登录页自己的接口完成登录：

- **短信验证码（推荐）**：`sendRegisterMessageCode.action` → `loginMobileByPhone.action`
- **账号密码**：`isNeedCpatcha` / `getClientCaptcha` → `loginDesktopClient.action`（RSA 加密密码）

登录成功后先用会话**真读一次订阅列表**，验证通过才把会话 Cookie 写进 dsh 凭据库。手机号、验证码、密码只用于这一次请求：**不保存、不入日志、不回显、不进模型上下文**。

## 安装

前置：已安装 DeepSeek Harness（桌面版或 CLI），并能在对话里使用插件管理器（`plugin_manager`）。

### 方式 A：clone 后本地安装（推荐）

```bash
git clone https://github.com/Ronnie-Young/dsh-scnet-plan.git
cd dsh-scnet-plan
```

然后在 DSH 对话里让 agent 执行：

```text
plugin_manager install_bundle  target = /绝对路径/dsh-scnet-plan
```

`plugin_manager` 需要 danger-full-access 权限，按提示批准即可。安装完成后**刷新页面**，侧栏出现 SCNet 图标。

### 方式 B：直接用 GitHub 源安装（实验性）

```text
plugin_manager install_bundle  target = github:Ronnie-Young/dsh-scnet-plan#v0.0.1
```

DSH 的安装器底层是 pnpm，`github:` 规格通常可用；如果失败，改用方式 A。

### 验证

- 侧栏出现「SCNet 套餐」图标，点开能看到额度面板；
- 设置 → SCNet 套餐 → 用短信验证码登录；
- 或让 agent 调用工具 `get_scnet_plan`。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（patch 会整体替换 `config`，要保留的键需一并写上）：

```yaml
- id: scnet-plan
  config:
    apiKeyEnv: SCNET_API_KEY
    consoleCookieEnv: SCNET_CONSOLE_COOKIE
    refreshIntervalSec: 300
    requestTimeoutMs: 15000
    includeModels: true
    warnBelowPercent: 20
    routePath: /scnet-plan/snapshot
    tool: true
    manageCookie: true
    accountLogin: true
    loginTimeoutSec: 30
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `SCNET_API_KEY` | API Key 的凭据引用名（只用于模型列表） |
| `baseUrl` | `https://api.scnet.cn` | OpenAI 兼容网关 |
| `consoleBaseUrl` | `https://www.scnet.cn` | 控制台地址（`/acx` 接口） |
| `apiBasePath` | `/api/llm/v1` | 网关路径前缀 |
| `consoleCookieEnv` | `SCNET_CONSOLE_COOKIE` | 会话 Cookie 的凭据引用名 |
| `refreshIntervalSec` | `300` | 缓存与自动刷新间隔（秒，0 = 只手动刷新） |
| `requestTimeoutMs` | `15000` | 单次请求超时 |
| `includeModels` | `true` | 附带模型列表与套餐目录 |
| `warnBelowPercent` | `20` | 低于该比例转警示色，低于 1/3 转错误色 |
| `routePath` | `/scnet-plan/snapshot` | Host 快照路由 |
| `tool` | `true` | 注册 `get_scnet_plan` 工具 |
| `manageCookie` | `true` | 允许设置页写入 Cookie（高级退路） |
| `accountLogin` | `true` | 允许短信/密码登录 |
| `loginTimeoutSec` | `30` | 登录请求超时 |

凭据通过 dsh 的 `credentials` 服务读写，默认引用名 `SCNET_API_KEY` / `SCNET_CONSOLE_COOKIE`，不会写进插件配置。

## 界面细节

- **圆环**：按剩余比例上色，>20% 绿、6.7–20% 琥珀、<6.7% 红；
- **2×2 指标**：剩余天数、今日消耗、日均消耗、可用模型数；
- **token 构成**：输入 / 缓存命中 / 输出（SCNet 把缓存命中单独计量，不是输入子集）；
- **每日热力图**：按订阅周期铺格，蓝色 4 档；
- **明细账单**：跳转控制台「费用 → 明细账单」。

每日用量失败不会影响额度数字，面板会提示“额度数字不受影响”。

## 更新

```bash
cd dsh-scnet-plan
git pull
```

然后让 agent 重新安装一次（插件管理器会重新链接并热更新）：

```text
plugin_manager remove_bundle   target = dsh-scnet-plan
plugin_manager install_bundle  target = /绝对路径/dsh-scnet-plan
```

最后刷新页面。版本号遵循 `vX.Y.Z` 的 git tag，Release 页面会写每个版本的变更；`package.json` 的 `version` 与 tag 保持一致。仓库创建、发版、npm 发布等完整流程见 [docs/publishing.md](docs/publishing.md)。

## 卸载

```text
plugin_manager remove_bundle  target = dsh-scnet-plan
```

## 开发

```bash
node --test test/*.test.mjs          # 36 个单测（含浏览器组件渲染冒烟）
node scripts/probe.mjs --self-test   # 离线校验控制台响应映射
SCNET_CONSOLE_COOKIE='a=b' node scripts/probe.mjs --json
```

`client.js` 是手写的浏览器 bundle（`window.__ModuleLoader__.load({ id, factory })`），不需要打包器；改完刷新页面即可。

## 项目结构

```
.
├── index.js              # Host 半：配置、凭据、路由、工具、settings 策略
├── client.js             # 浏览器半：面板 / 设置页 / 输入框徽标
├── lib/
│   ├── scnet-api.js      # 网关模型、公开目录、订阅与每日用量
│   ├── plan-service.js   # TTL + single-flight 缓存，失败保留上一次快照
│   ├── console-auth.js   # 短信/密码登录：签名、RSA、验证、只存会话
│   └── format.js         # get_scnet_plan 的输出 schema 与文字渲染
├── test/                 # node:test 单测
├── scripts/probe.mjs     # 独立探针
├── docs/scnet-api.md     # 接口契约与字段证据
├── docs/plugin-platform.md  # DSH 插件平台契约
├── docs/panel-design.md  # 面板设计评审记录
└── cordis.patch.yml      # bundle 层
```

## 已知取舍

- 暂未做「按模型筛选」热力图（官方有 `modelName` 参数，目前固定全部模型）；
- 每日用量是 SCNet 统计结果，官方说明有最长约 5 分钟延迟；
- 会话 Cookie 过期后需在设置页重新登录一次。

## 验证记录

- Host 路由：`GET /scnet-plan/snapshot` 返回真实订阅（`source: console`）、每日用量与模型目录；
- 登录：SMS 与密码两条链路均已走通；无效 Cookie → `SESSION_REQUIRED` 并降级到公开目录；
- 浏览器组件：36 个单测覆盖调度、映射、登录协议、缓存与渲染冒烟。

## 许可证

MIT © Ronnie-Young

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
