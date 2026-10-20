# SCNet 模型服务 / Token Plan —— API 契约与取数方案

> 目标：为 DeepSeek Harness 的 SCNet provider 插件找到「token 套餐 / 剩余额度」的数据来源。
> 实测时间：**2026-10-20（Asia/Shanghai）**，全部为只读探测（GET / 一次 1-token chat 请求），未登录、未购买、未尝试猜测凭据。
> 密钥：仅以 `<SCNET_API_KEY>` 指代，任何日志/文档/脚本输出中都不出现明文。

---

## 0. 结论先行（TL;DR）

| 问题 | 答案 | 置信度 |
|---|---|---|
| 只给 API Key，能否拿到「本月总额度 / 已用 / 剩余」的数字？ | **不能。** 全站没有任何 key 鉴权的额度接口。 | **高**（穷举 + 前端源码 + 官方文档三重印证） |
| 那 Key 能干什么？ | `/models` 列表、`/chat/completions` 等推理接口；响应里的 `usage` 可用于**本地记账**。 | 高（实测 200） |
| 额度数字在哪里？ | 控制台 SPA `https://www.scnet.cn/ui/console/index.html#/llm/token-plan`，走后端 `/acx/charge/account/currentuser/tokenplan/list`，**依赖登录态 Cookie**。 | 高（前端分包源码 + 401 实证） |
| 有没有不需要鉴权的有用数据？ | 有：**套餐目录**（档位、月额度 Credits、可用模型）`GET /acx/llm/api/package/overview?packageType=TokenPlan`，**匿名 200**。 | 高（实测 200） |
| 没有 Cookie 时，能不能至少判断「套餐是否还有额度」？ | 能，但是**状态级**不是数字级：用 1 次 1-token 探测请求，按官方错误码区分 `正常 / 额度耗尽(429) / 套餐过期(403) / 未订阅(403) / Key 失效(401)`。 | 中高（错误码来自官方文档，未实际触发 429/403） |

| 套餐额度单位是什么？ | **Credits**（按月），不是裸 token；`tokenplan/list` 返回 total/used/percent，前端不做 token 换算。 | 高（前端 + 官方文档） |

**给插件的建议**：无 Cookie 时走「Key + 公共目录 + 状态探测」，`remainingCredits` 只能是 `null` 或 `state-only`；
要精确数字必须让用户从浏览器控制台粘贴 `Cookie`（或等 SCNet 开放 key 鉴权的额度接口）。
两处实现见 `scnet-plan/scripts/probe.mjs`（`--cookie` / 无 Cookie 双模式，见 §10）。

---

## 1. 主机与路径布局（实测确认）

| 主机 / 前缀 | 角色 | 鉴权 | 备注 |
|---|---|---|---|
| `https://api.scnet.cn/api/llm/v1` | OpenAI 兼容推理网关 | `Authorization: Bearer <SCNET_API_KEY>` | `/models`、`/chat/completions`、`/responses`、`/embeddings` 等 |
| `https://api.scnet.cn/api/llm/anthropic` | Anthropic 兼容网关 | 同上 | 文档：`/v1/messages` |
| `https://www.scnet.cn/acx` | **控制台业务 API 前缀**（唯一有效） | 登录态 Cookie（+ 可能的 `token` 头） | 所有 `/llm/*`、`/charge/*` 业务接口 |
| `https://www.scnet.cn/ac` | 旧/其他业务前缀 | — | 对本文所有 `/llm/*`、`/charge/*` 路径返回 **HTML 404**，**不要用** |
| `https://www.scnet.cn/ui/mall/` | Nuxt 商城（价格、购买入口） | 匿名 | 只用于发现 `/llm/token-plan` 前端路由 |
| `https://www.scnet.cn/ui/console/index.html#/llm/token-plan` | 控制台 Token Plan 页面（hash 路由 SPA） | 登录态 | 人工核对数字的唯一权威 UI |

> 判断「前缀是否有效」的快捷方法：`/ac/...` 返回 `<!DOCTYPE html>` 404；`/acx/...` 返回 JSON（`{"code":"401",...}` 或业务数据）。

### 1.1 网关与会话层共用同一套鉴权过滤器

`api.scnet.cn` 的未知路径返回 **JSON 404**，例如：

```http
GET https://api.scnet.cn/openapi/llm/v1/models
→ 404 {"code":404,"msg":"api is not found","data":""}
```

而对 `/api/llm/v1/usage`、`/quota`、`/me`、`/dashboard/billing/subscription` 等路径返回的是**会话过滤器**的 401（形状与 `www.scnet.cn/acx` 完全一致，`data.Referer` 为空）。含义：

- 401 表示「请求被会话/登录过滤器拦下」，**不代表该路径一定存在**，也**不代表 key 无效**；
- 因此**不能**用 401 作为「接口存在」的证据，只能用 200 或前端源码作为证据。本文档对每个接口都标注了证据类型。

---

## 2. 接口清单（含证据与置信度）

### E1. 模型列表 —— ✅ 已实测 200

```http
GET https://api.scnet.cn/api/llm/v1/models
Authorization: Bearer <SCNET_API_KEY>
Accept: application/json
```

- 证据：实测 200，18 个模型。
- **代理等价路径**（实测 200，同一 payload）：`GET https://www.scnet.cn/acx/llm/v1/models` + 同样的 Bearer。
  只配了控制台前缀的客户端可以用它；但**仍然只返回模型列表，没有任何额度信息**。
- 响应头（**没有任何** `x-ratelimit-*` / `x-quota-*` / 额度相关头）：

```http
HTTP/2 200
server: nginx
content-type: application/json
x-trace-id: 8a72156f41783acd
set-cookie: SKIP_SESSION_UPDATE=...; path=/; Max-Age=180
access-control-allow-methods: GET, POST, OPTIONS
access-control-allow-headers: Content-Type, Authorization, X-Requested-With
```

- 响应体（真实，节选）：

```json
{
  "object": "list",
  "data": [
    { "id": "DeepSeek-V4.1-Flash-1017", "object": "model", "ownedBy": "system" },
    { "id": "DeepSeek-V4.1-Flash",      "object": "model", "ownedBy": "system" },
    { "id": "Kimi-K3",                  "object": "model", "ownedBy": "system" },
    { "id": "GLM-5.3-Flash",            "object": "model", "ownedBy": "system" },
    { "id": "Qwen3.8-Flash",            "object": "model", "ownedBy": "system" },
    { "id": "GLM-5.3",                  "object": "model", "ownedBy": "system" },
    { "id": "MiniMax-M3",               "object": "model", "ownedBy": "system" },
    { "id": "DeepSeek-V4-Pro-0813",     "object": "model", "ownedBy": "system" }
  ]
}
```

其余 id：`Qwen3.8-Max`、`DeepSeek-V4-Flash-0731`、`GLM-5.2`、`GLM-5.1`、`Kimi-K2.7-Code`、`Kimi-K2.6`、`Kimi-K2.5`、`GLM-5`、`MiniMax-M2.7`、`MiniMax-M2.5`。

> ⚠️ `GET /api/llm/v1/models/<model-id>` 是 **401 会话门**（实测），别用它查单价/额度。

### E2. Chat Completions —— ✅ 已实测 200，带 `usage`

```http
POST https://api.scnet.cn/api/llm/v1/chat/completions
Authorization: Bearer <SCNET_API_KEY>
Content-Type: application/json

{"model":"DeepSeek-V4.1-Flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":false}
```

真实响应（2026-10-20，`max_tokens:1`，花费极小）：

```json
{"id":"e31d2ff52647a716-20261020125504298","created":1792472104,"model":"DeepSeek-V4.1-Flash",
 "object":"chat.completion","system_fingerprint":"e72d3c7f663d3e1383b00b3884cb4501",
 "choices":[{"finish_reason":"length","index":0,
   "message":{"content":"","role":"assistant","reasoning_content":"The"},
   "provider_specific_fields":{}}],
 "usage":{"completion_tokens":1,"prompt_tokens":31,"total_tokens":32,
   "completion_tokens_details":{"reasoning_tokens":1},
   "prompt_tokens_details":{"cached_tokens":0},
   "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":31}}
```

- **响应头里没有任何额度/限流线索**（只有 `x-trace-id` 与 `SKIP_SESSION_UPDATE` cookie）。
- `usage` 是唯一可用于记账的字段：`prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_tokens_details.cached_tokens`（缓存命中）。
- Anthropic 协议下对应 `usage.input_tokens` / `output_tokens` / `cache_read_input_tokens`（官方计费页口径）。

### E3. Token Plan 套餐目录 —— ✅ 匿名 200（无需任何凭据）

```http
GET https://www.scnet.cn/acx/llm/api/package/overview?packageType=TokenPlan
（无鉴权头、无 Cookie）
```

真实响应（节选；价格与额度为公开商品信息）：

```json
{
  "code": "0",
  "msg": "success",
  "data": [
    {
      "packageType": "TokenPlan",
      "name": "基础版",
      "code": "TP-Basic-001",
      "models": "GLM-5.3,GLM-5.2,GLM-5.1,GLM-5,DeepSeek-V4-Pro-0813,DeepSeek-V4-Flash-0731,Kimi-K3,Kimi-K2.7-Code,Kimi-K2.6,Kimi-K2.5,MiniMax-M3,MiniMax-M2.7,MiniMax-M2.5,Qwen3.8-Max,GLM-5.3-Flash,Qwen3.8-Flash,DeepSeek-V4.1-Flash,DeepSeek-V4.1-Flash-1017",
      "request": [{ "time": 1, "unit": "month", "limit": 60000 }],
      "description": "入门优选，适合个人项目集成 / AI 助手",
      "regularPrice": 50,
      "packageContent": { "模型": "GLM-5.3,..." },
      "modelContent": [
        {
          "modelName": "DeepSeek-V4.1-Flash",
          "maxToken": 1024,
          "modelType": "LLM",
          "brand": "DeepSeek",
          "tags": ["文本生成", "深度思考"],
          "apiProtocols": ["OpenAI", "Anthropic", "OpenAI Responses"]
        }
      ]
    }
  ]
}
```

四个档位（实测）：

| code | name | 月额度（Credits） | 活动价/月 |
|---|---|---:|---:|
| `TP-Basic-001` | 基础版 | 60,000 | ¥30 |
| `TP-Standard-001` | 标准版 | 240,000 | ¥130 |
| `TP-Advanced-001` | 高级版 | 600,000 | ¥310 |
| `TP-Premium-001` | 旗舰版 | 1,800,000 | ¥899 |

- `request[0].limit` 就是**月度 Credits 总额**；`request[0].time/unit` 为周期（1 month）。
- `packageType` 还接受 `CodingPlan`（同样匿名 200），与本插件无关。
- 该接口**没有 CORS 头**（`OPTIONS` 返回 403），浏览器跨域不可用；Node/插件主进程可用。

### E4. 当前用户 Token Plan 列表 —— 🔒 会话门（额度数字在这里）

```http
GET https://www.scnet.cn/acx/charge/account/currentuser/tokenplan/list
Cookie: <登录态 Cookie>
（可选）token: <控制台 token>
```

- 匿名实测：`401 {"code":"401","msg":"用户未登录!","data":{"Referer":"http://www.scnet.cn/account/currentuser/tokenplan/list"}}`
- 带 `Authorization: Bearer <SCNET_API_KEY>` 实测：**仍然 401**（同一 body）。→ **API Key 不参与该接口鉴权**。
- 再加 `version: 2.9.2` + 浏览器 UA + `Referer: https://www.scnet.cn/ui/console/` + 假 Cookie 实测：**仍然 401**。
  → 这些头只能让请求「看起来像控制台」，**不能替代会话 Cookie**；`token` 头同理（前端仅在 Shell 类服务上用）。
- 证据：`www.scnet.cn/ui/console/static/js/16.570e8f6b.js`（控制台前端）中 `M=()=>(0,l.bE)({url:"/charge/account/currentuser/tokenplan/list",method:"GET"})`，`l.bE` 是 `baseURL:"/acx"` 的 axios 实例。
- 响应体**未实测**（需登录）。字段名从控制台前端**逐函数**核对得到（证据：`68.9ce4d2a7.js` 模块 `50869`，被 `2938.dcf9ebd5.js` 的 TokenPlan 页面消费）。

#### E4.1 响应信封（envelope）

前端 `y()` / `f()` 两个解包函数的行为（`68.9ce4d2a7.js`）：

```js
// 单层解包：res 本身或 res.data
const y = (e) => (e && typeof e === 'object' && 'data' in e) ? e.data : e;
// 列表解包：data → date → 原样必须是数组
function f(e){ let n = (e && e.data) ?? (e && e.date); return Array.isArray(n) ? n : []; }
```

所以 `/acx/charge/account/currentuser/tokenplan/list` 的真实信封是
**`{ "code": "0", "msg": "success", "data": [ <subscription row>, ... ] }`**（与套餐目录一致），
但实现应对下列形状都兼容：

| 形状 | 处理 |
|---|---|
| `{code,msg,data:[…]}` | 标准；取 `data` |
| `{code,msg,data:{data:[…]}}` / `{data:{records:[…]}}` / `{data:{list:[…]}}` | 前端多处兼容，`probe.mjs` 同样兼容 |
| 裸数组 `[… ]` | 直接使用 |
| `{date:[…]}` | 兼容（历史遗留） |

行数组还会被前端排序/筛选：`status==='enable'` 优先、再按 `minValidTime` 倒序；
`totalDays<=0` 的行被归入「订阅历史」（`Zw`/`S1` 两个过滤器）。

#### E4.2 每行字段名（**按前端取值优先级**，从源码逐字提取）

| 语义 | 字段候选（按顺序，先命中先用） | 出处（函数） | 置信度 |
|---|---|---|---|
| 总额度 `totalCredits` | `totalAmount` → `All` → `totalCredits` → `monthlyCredits` → `planCredits` → `creditQuota` → `quota` → `limit` → `total` | `me()`（用量面板）与 `H()`（= 导出名 `BQ`，订阅卡） | **语义高**；首个真实字段名待登录实测 |
| 已用 `usedCredits` | `usedAmount` → `used` → `usedCredits` → `consumeCredits` → `consumedCredits` → `consume` → `usage` | `me()` 与 `G()`（= `VQ`） | 同上 |
| 剩余 `remainingCredits` | `remainingCredits` → `remainCredits` → `leftCredits` → `remaining` → `remain` | `me()` | 同上（**接口可能不返回，前端用 total−used 兜底**） |
| 占比 `percent` | `percent` → `usagePercent` → `rate`；`0<p≤1` 视为小数自动 ×100；缺失则 `round(used/total*100)` | `M()` / `normalizePercent` | 同上（前端再 clamp 到 0–100） |
| 套餐名 `planName` | `name` → `resourceName` → `packageName` →（目录 `code` 匹配）→ `resourceId` | `$()`（= `$9`） | 高 |
| 商品码 `resourceId` | `resourceId` → `code` → `packageCode` | `V()`（= `Mk`） | 高（`TP-Basic-001` 等，与目录 `code` 对齐） |
| 生效 `startAt` | `minValidTime` → `startTime` → `validTime` | 页面 `startTime` 绑定 | 高 |
| 到期 `endAt` | `maxExpireTime` → `expireTime` → `endTime` | 页面 `endTime` 绑定 | 高 |
| 重置 `resetAt` | `resetTime` → `resetAt` → `nextResetTime` → `monthResetTime`；缺失则 `endAt + 1s` | `me()` | 中高（官方口径「到期时间的下一秒」） |
| 状态 `status` | `status`（`enable`/`disable`）、`totalDays`（≤0 ⇒ 过期）、`currentTime`、`minValidTime`、`maxExpireTime` | `K()` / `x()` / `P()` | 高 |
| 用量查询用 ID | `accountId`、`resourceAccountId`、`orderId` | `fe()` 构造用量查询参数 | 高 |
| 其他 | `saleStatus`、`soldOut/sellOut/sold_out/temporarilySoldOut`、`snapshotTime`/`lastStatTime`/`statTime`/`updateTime` | `_()`、`ye()` | 中（购买/时间戳辅助字段） |

> **解析策略：不要假设单一字段名**，按上表链式取值（`pickFirstDefined`），全部缺失才置 `null` 并告警。
> 原因：前端自己就写了 7~9 个候选名，说明后端字段名在版本间变过；`probe.mjs` 已内置同一套候选表。

建议的**合成**响应（字段名取自上表，用于对接联调，非真实数据）：

```json
{
  "code": "0",
  "msg": "success",
  "data": [
    {
      "resourceId": "TP-Basic-001",
      "name": "基础版",
      "status": "enable",
      "minValidTime": "2026-10-19 00:00:00",
      "maxExpireTime": "2026-11-18 23:59:59",
      "totalDays": 30,
      "currentTime": "2026-10-20 12:50:00",
      "accountId": "0",
      "resourceAccountId": "0",
      "planCredits": 60000,
      "usedCredits": 1234.5,
      "remainingCredits": 58765.5,
      "percent": 0.0206,
      "resetTime": "2026-11-19 00:00:00"
    }
  ]
}
```

> 端到端映射自检（离线，不发请求）：`node scnet-plan/scripts/probe.mjs --self-test`

### E5. 其他会话门接口（前端源码证据，全部 401）

| 方法 | 路径（前缀 `https://www.scnet.cn/acx`） | 用途 | 证据 |
|---|---|---|---|
| POST | `/charge/account/llmapi/balance` | 账户余额（现金/赠送） | 前端 + 实测 401 |
| POST | `/charge/account/llmapi/resource/list/statistics` | 资源用量统计 | 前端 |
| GET | `/llm/api/usage/amount` | 用量汇总 | 前端 + 实测 401 |
| GET | `/llm/api/usage/analysis` | 用量分析（图表） | 前端 |
| GET | `/llm/api/usage/logs/page` | 调用日志分页 | 前端 |
| GET | `/llm/api/usage/model-tree` | 按模型聚合 | 前端 |
| GET | `/llm/api-key/token-plan/query` | 套餐专属 Key 查询 | 前端 + 实测 401 |
| POST | `/llm/api-key/token-plan/create` / `/reset` | 创建/重置专属 Key | 前端（**写操作，插件禁用**） |
| GET | `/llm/api-key/query` / `options` / `detail` | Key 列表/详情 | 前端 + 实测 401 |
| GET | `/llm/account/model/free-quota/batch`、`POST .../free-quota/query` | 免费额度 | 前端 |
| GET | `/llm/api/console/model` | 模型目录（控制台版） | 前端 + 实测 401 |
| POST | `/charge/consume-query/resource-usage` | **套餐内按模型/按天的用量**（Token Plan 页「用量消耗/Credits 消耗」图） | 前端 |
| POST | `/charge/details/llmapi-fee-count-history` | 费用曲线 | 前端 |
| POST | `/charge/details/quick-board` | 首页看板 | 前端 |

（"前端"= 出现在 `ui/console` 打包产物里；这些接口**全部**需要登录态，实测提示语一致。）

#### E5.1 这些接口对「剩余额度」有没有增量？**没有数字增量，只有明细**

| 接口 | 返回什么 | 对 `remainingCredits` 的贡献 |
|---|---|---|
| `tokenplan/list`（E4） | 订阅行的 total/used/percent/有效期 | **唯一数据源** |
| `POST /acx/charge/consume-query/resource-usage` | 明细记录：`date`、`sumUsage`（当日 Credits）、`inputTokens`、`cachedTokens`、`outputTokens`、`chargeItem`（`LLMAPI-INPUT`/`LLMAPI-CACHED`/`LLMAPI-OUTPUT`） | 只做「趋势图」，总额仍取 E4。请求体：`{accountId, resourceAccountId, startTime, endTime, modelName}`（`fe()`/`tt()`），响应同 E4.1 信封（数组或 `data.records`/`data.list`） |
| `POST /acx/charge/account/llmapi/balance` | 现金余额 / 赠送额度（按量计费账户） | **不同账户体系**，与 Token Plan 的 Credits 无关；不要混用 |
| `GET /acx/llm/api/usage/amount` · `/usage/analysis` · `/usage/logs/page` · `/usage/model-tree` | 「模型用量」页的统计 | Token Plan 页**不调用**它们；不提供剩余额度 |

> Token Plan 页的「Credits 消耗」卡片实际是**用 E4 的同一行**渲染的（`y.value = de.Nc(row)` → `records:[me(row)]`），
> 也就是说：**一个 `tokenplan/list` 就够画订阅卡 + 进度条 + 用量面板**，无需求的额外接口。

---

## 3. 归一化字段映射（单位统一为 **Credits**）

插件统一输出（与插件实现的取名字段一致）：

```json
{
  "planName": "基础版",
  "status": "active | exhausted | pending | expired | missing | invalid-key | unknown",
  "totalCredits": 60000,
  "usedCredits": 1234.5,
  "remainingCredits": 58765.5,
  "percent": 2,
  "startAt": "2026-10-19T00:00:00+08:00",
  "endAt": "2026-11-18T23:59:59+08:00",
  "resetAt": "2026-11-19T00:00:00.000+08:00",
  "subscriptions": [
    {
      "planName": "基础版",
      "resourceId": "TP-Basic-001",
      "status": "active",
      "totalCredits": 60000,
      "usedCredits": 1234.5,
      "remainingCredits": 58765.5,
      "percent": 2,
      "startAt": "2026-10-19T00:00:00+08:00",
      "endAt": "2026-11-18T23:59:59+08:00",
      "resetAt": "2026-11-19T00:00:00.000+08:00"
    }
  ],
  "models": ["DeepSeek-V4.1-Flash", "..."],
  "source": "console-cookie | catalog+probe | catalog-only | none",
  "fetchedAt": "2026-10-20T13:00:00+08:00",
  "unit": "credits",
  "confidence": "exact | partial | state-only | catalog | none"
}
```

顶层字段 = 当前生效订阅（active 优先，其次 exhausted/pending，再按 `endAt` 倒序取第一行）；
`subscriptions[]` 是全部订阅行（含已过期历史）。

| 归一化字段 | 来源 | 单位/口径 | 备注 |
|---|---|---|---|
| `planName` | E4.2 `name`/`resourceName`/`packageName`；或目录 `name` | 文本 | 无 Cookie 时为 `null` |
| `status` | E4.2 `status`+`totalDays`+`currentTime`；或探测错误码 | 枚举 | `429`→`exhausted`，`403 … expired`→`expired`，`403 … missing`→`missing`，`401 Authentication Failed`→`invalid-key` |
| `totalCredits` | E4.2 候选链；缺失时退回目录 `request[].limit` | **Credits/月** | Credits ≠ tokens（见 §4） |
| `usedCredits` | E4.2 候选链 | Credits | 官方统计有**最长 5 分钟**延迟 |
| `remainingCredits` | 行内候选链，否则 `total − used` | Credits | 缺失任一端即 `null` |
| `percent` | 行内 `percent`/`usagePercent`/`rate`（0–1 自动 ×100），否则 `round(used/total*100)`，clamp 0–100 | % | 缺失即 `null`（前端兜底为 0） |
| `startAt` | `minValidTime` | ISO8601 +08:00 | |
| `endAt` | `maxExpireTime` | ISO8601 +08:00 | 到期即 Key 失效（官方） |
| `resetAt` | `resetTime`/`resetAt`/`nextResetTime`/`monthResetTime`，否则 `endAt + 1s` | ISO8601 +08:00 | 官方：`到期时间的下一秒`，例 11-18 23:59:59 到期 → 11-19 00:00:00 重置 |
| `subscriptions[]` | E4 全部行 | 同上字段 | 供「订阅历史」UI |
| `models[]` | E3 `modelContent[].modelName` 或 `models`（逗号分隔）；或 E1 全集 | 文本数组 | 四档均含全部 18 个模型 |
| `source` | 取数路径 | 枚举 | `console-cookie`（精确）/ `catalog+probe`（仅状态）/ `catalog-only`（只有档位表） |
| `fetchedAt` | 本地时间 | ISO8601 | |

---

## 4. Credits ≠ Tokens（关键单位陷阱）

官方计费页与 Token Plan 页明确：套餐额度单位是 **Credits**，按模型「综合抵扣倍率」把 token 折算成 Credits 扣减。

估算公式（`source = catalog+ledger` 时使用）：

```
credits ≈ (uncached_prompt_tokens × in_rate + cached_prompt_tokens × cache_rate + completion_tokens × out_rate) × 综合抵扣倍率
```

其中「综合抵扣倍率」（官方表格，随周调整，仅作估算）：

| 模型 | 倍率 | 模型 | 倍率 |
|---|---:|---|---:|
| DeepSeek-V4.1-Flash(-1017) | 0.19 | GLM-5.2 | 1.10 |
| DeepSeek-V4-Flash-0731 | 0.20 | GLM-5.1 | 1.40 |
| DeepSeek-V4-Pro-0813 | 0.67 | GLM-5 | 1.11 |
| Qwen3.8-Flash | 0.12 | Kimi-K3 | 4.10 |
| Qwen3.8-Max | 1.97 | Kimi-K2.7-Code | 1.00 |
| GLM-5.3-Flash | 0.15 | Kimi-K2.6 | 1.00 |
| GLM-5.3 | 1.83 | Kimi-K2.5 | 0.65 |
| MiniMax-M3 / M2.7 | 0.43 | MiniMax-M2.5 | 0.30 |

> 实际单价按「输入 / 缓存命中输入 / 输出」三档，且倍率按周调整 —— 因此本地记账只能标 `estimated`，并在 UI 上写「估算」。
> 若只想粗估：`credits ≈ total_tokens × 倍率`（对 DeepSeek-V4.1-Flash 约 `0.19 credits / token`）。

---

## 5. 错误模式（实测 + 官方文档）

### 5.1 网关（`api.scnet.cn/api/llm/v1/*`）

| HTTP | body（实测） | 触发条件 | 处理建议 |
|---|---|---|---|
| 400 | `{"error":{"message":"Authorization格式错误，正确格式为Bearer <APIKey> (request_id: ...)","code":"400","type":"invalid_request_error"}}` | 无 `Authorization`，或不是 `Bearer ` 前缀（`X-API-Key: ...` 也报这个） | 只能 `Authorization: Bearer` |
| 401 | `{"error":{"message":"Authentication Failed (request_id: ...)","code":"401",...}}` | Key 不存在/格式对但无效 | 提示检查 `/models` 是否 200 |
| 401 | `{"code":"401","msg":"用户未登录!","data":{"Referer":""}}` | **会话门**：该路径只认登录态，key 无效力 | 不要重试、不要当成 key 失效 |
| 403 | `403 ... Plan subscription is missing` | 账号没有 Token Plan | 引导去控制台订阅 |
| 403 | `403 ... Plan subscription is expired` | 套餐过期（Key 同时失效） | 引导续费 |
| 403 | `403 The current model does not support … Plan` | 模型名不在套餐列表（区分大小写） | 校验模型名 |
| 429 | `429 Allocated Quota Exceeded` | **本月 Credits 用尽** | 这正是「剩余为 0」的可观测信号 |
| 404 | `{"code":404,"msg":"api is not found","data":""}` | 路径不存在 | 前缀写错 |
| 5xx | — | 平台故障 | 退避重试 |

> 403/429 文案来自官方 `#/help/docs/mainsite/mass/plans/errorcode`；未实际触发（会真花钱/需账号状态），标 **中高置信**。

### 5.2 控制台（`www.scnet.cn/acx/*`）

| HTTP | body（实测） | 条件 |
|---|---|---|
| 401 | `{"code":"401","msg":"用户未登录!","data":{"Referer":"http://www.scnet.cn/account/currentuser/tokenplan/list"}}` | 无登录 Cookie（**带 API Key 也一样**） |
| 404 | HTML `<!DOCTYPE html>...` | 用错前缀 `/ac`（而非 `/acx`） |
| 200 | `{"code":"0","msg":"success","data":...}` | 匿名可用的只有 §2 E3 目录接口 |

`data.Referer` 是网关内部路由名（`http://www.scnet.cn/account/...`），可用来确认「该业务接口确实存在，只是被会话门挡住」。

---

## 6. 「只有 API Key」能做到什么 / 做不到什么

### ✅ 能

1. 列模型（E1）。
2. 推理（E2），并从 `usage` 拿每次调用的 token 明细 → 本地记账。
3. 拉**公共套餐目录**（E3，甚至不需要 Key）→ 档位、月额度 Credits、可用模型。
4. **状态级**判断套餐健康度：发一次 `max_tokens:1` 的探测请求
   - 200 → `status=active`（有额度，但不知道剩多少）
   - 429 → `status=exhausted`（`remainingCredits=0`）
   - 403 expired / missing → `status=expired` / `missing`
   - 401 Authentication Failed → Key 本身失效
5. 结合本地账本 + §4 公式给出 `remainingCredits` **估算值**。

### ❌ 不能（已穷举确认）

1. 任何 key 鉴权的「已用/剩余 Credits」接口 —— `api.scnet.cn` 与 `www.scnet.cn/acx` 两处都会落到会话过滤器。
2. 从响应头读额度 —— `/models`、`/chat/completions` 都**没有任何** `x-ratelimit-*`、`x-quota-*`、`x-balance-*` 头。
3. 从 Key 内容推额度 —— Key 只是 `sk-tp-` + base64(`<3位租户码>-<11位账号>-<13位毫秒时间戳>`)，不含额度信息（见 §8）。
4. 跨域浏览器直连 `www.scnet.cn/acx` —— 无 CORS 头，`OPTIONS` 403。插件必须在 Node 侧请求。

---

## 7. 三种取数方案（按推荐度）

### 方案 A：控制台 Cookie（唯一能拿到精确数字的路）

- 用户在浏览器登录 `www.scnet.cn`，打开 `https://www.scnet.cn/ui/console/index.html#/llm/token-plan`，
  从 DevTools → Network 任意 `/acx/*` 请求复制 **完整 `Cookie` 请求头**（会话 Cookie 是 HttpOnly，JS 读不到）。
- 插件配置项 `scnetSessionCookie`，请求 E4：

```http
GET https://www.scnet.cn/acx/charge/account/currentuser/tokenplan/list
Cookie: <粘贴的 Cookie>
Accept: application/json
```

- 前端 axios 还会在部分服务上带 `token` 请求头（`ServiceUrl` 下发），但普通业务接口靠同源 Cookie；必要时两者都配（`token` 头也可作为配置项）。
- Cookie 会过期，需在 UI 中提示「登录态失效（401）→ 重新粘贴」。
- 置信度：路径 **高**，字段语义 **高**、首个真实字段名 **中**（前端多名字兼容，见 §2 E4.2；`probe.mjs --self-test` 可离线验证映射）。
- 请求头建议与前端一致：`Referer: https://www.scnet.cn/ui/console/`、`version: 2.9.2`、浏览器 UA；实测这些头**不能**替代 Cookie（不带 Cookie 仍 401）。

### 方案 B：Key + 公共目录 + 本地记账 + 状态探测（无 Cookie 的默认路径）

- E1 模型 + E3 目录（拿档位额度，前提是用户在插件里选档位，或只显示上限）
- 本地使用账本（插件自己记录的每次 `usage`）→ §4 估算 Credits
- 每次打开面板时一次 1-token 探测（可缓存 5–10 分钟，避免无谓花费）→ `active/exhausted/expired/missing`
- 输出 `confidence: "state-only"` / `"catalog"`，UI 明示「估算/仅状态，精确值请到控制台」。

### 方案 C：公共页面抓取（不推荐）

`#/llm/token-plan` 是 hash 路由 SPA，数字由 `XHR + Cookie` 渲染，**静态 HTML 里没有额度**，抓取拿不到。仅当你**已经**有登录态时才可能用无头浏览器，仍不如方案 A 稳。

---

## 8. API Key 结构（安全说明）

- 格式：`sk-tp-` + base64(`<3位数字>-<11位数字>-<13位毫秒时间戳>`)，本机这把 Key 的创建时间戳解出来是 **2026-10-19T01:21:57Z**。
- 它**不是** JWT，没有签名/过期声明，不能解出额度、套餐、剩余天数。
- 官方约束（Token Plan 文档）：每人仅 1 个 Token Plan、每订阅 1 个 `sk-tp-` Key；套餐到期 Key 即失效；额度用尽**不会**自动转按量计费。
- 安全要求：任何日志、错误信息、UI 都不得回显 Key 明文；`probe.mjs` 已做脱敏（只显示 `sk-tp-****` 与长度）。

---

## 9. 发现路径（可复现）

1. `GET https://www.scnet.cn/ui/mall/` → 132 KB HTML，132 个 `_nuxt/*.js` 分包；grep 到 `/llm/token-plan`、`/llm/apikeys` 两个前端路由与 `/llm/api/package/overview?packageType=TokenPlan`。
2. 文档树：`https://www.scnet.cn/help/docs/mainsite/mass/**`（VitePress），其中
   - `plans/token-plan.html` —— 套餐规则、四档额度、倍率表、「查看用量：控制台 → 模型服务 → Token Plan」
   - `tutorial/token.html` —— 计费口径（Credits、缓存命中、5 分钟延迟）
   - `plans/errorcode.html` —— §5 的 401/403/429 文案
   - 这些页里直接给出了控制台地址 `https://www.scnet.cn/ui/console/index.html#/llm/token-plan`
3. `https://www.scnet.cn/ui/console/index.html` → `static/js/app.ffd5d85f.js`（3.3 MB），解析出
   - axios 实例 baseURL：`/ac`、`/acx`、`/home`、`/sso`、`/ske`
   - hash 路由表：`llmTokenPlan → /llm/token-plan → chunk 4218,6100,68,2938`
   - webpack chunk map（308 个 chunk）→ 用哈希下载 `16.570e8f6b.js`、`68.9ce4d2a7.js`、`2938.dcf9ebd5.js`
4. 在 `16.570e8f6b.js` 中找到全部业务 URL 常量（§2 E4/E5 的来源）；随后在 `68.9ce4d2a7.js`（模块 `50869`）核对字段取值链、在 `2938.dcf9ebd5.js` 核对页面消费方式（`planCreditsText`/`usedCreditsText`/`percent`）。
5. 逐个实测：`/ac` 全 404（HTML），`/acx` 返回 JSON；E3 匿名 200，其余 401。
6. 网关侧：`/models` 200；`/usage`、`/quota`、`/me`、`/dashboard/billing/subscription`、`/models/<id>` 均 401 会话门；`/openapi/*` 404 JSON。
7. 一次 `max_tokens:1` 的真实补全 → 确认 `usage` 字段存在、且**无**限流/额度响应头。
8. 反向验证「头部不能替代会话」：`/acx/…/tokenplan/list` 带 `version: 2.9.2` + 浏览器 UA + `Referer` + `Authorization: Bearer` + 假 Cookie → 仍 401。
9. 反向验证代理路径：`GET https://www.scnet.cn/acx/llm/v1/models` + Bearer → **200**（与 api.scnet.cn 同 payload）。

---

## 10. probe.mjs 用法

`scnet-plan/scripts/probe.mjs`（零依赖 ESM，Node ≥ 18，只读）：

```bash
# 无 Cookie：公共目录 + key 校验 + SESSION_REQUIRED 诊断（不花钱）
node scnet-plan/scripts/probe.mjs

# 精确 Credits：先登录控制台，复制任意 /acx/* 请求的 Cookie 头
node scnet-plan/scripts/probe.mjs --cookie 'SESSION=...; ...' --json
SCNET_CONSOLE_COOKIE='SESSION=...; ...' node scnet-plan/scripts/probe.mjs

# 从文件读取 Cookie（避免进 shell history）
node scnet-plan/scripts/probe.mjs --cookie-file ~/.scnet-cookie

# 附带状态探测（1 次 max_tokens:1 补全；用于判断 429/403）
node scnet-plan/scripts/probe.mjs --probe

# 离线验证 console 响应 → 归一化映射（不发任何请求）
node scnet-plan/scripts/probe.mjs --self-test
```

| 退出码 | 含义 |
|---|---|
| 0 | 拿到精确套餐数据（Cookie 模式） |
| 2 | 找不到 API Key |
| 3 | 需要会话：无 Cookie 或 Cookie 失效（输出 `SESSION_REQUIRED`/`COOKIE_EXPIRED`） |
| 4 | Key 被网关拒绝 |
| 5 | 网络/其他错误 |

输出（`--json`）即 §3 的归一化结构，外加 `key`（仅 `sk-tp-****` 与长度）、`cookie.present`、
`catalog[]`、`gateway.models[]`、`probe`、`diagnostics[]`、`warnings[]`。
**任何情况下都不打印 Key 或 Cookie 值**；`diagnostics` 里只出现 Cookie 的名字。

---

## 11. 参考链接

- Token Plan 产品与规则：<https://www.scnet.cn/help/docs/mainsite/mass/plans/token-plan.html>
- 计费说明（Credits/缓存/延迟）：<https://www.scnet.cn/help/docs/mainsite/mass/tutorial/token.html>
- 套餐错误码：<https://www.scnet.cn/help/docs/mainsite/mass/plans/errorcode.html>
- API 概览：<https://www.scnet.cn/help/docs/mainsite/mass/api/overview.html>
- 控制台 Token Plan 页：<https://www.scnet.cn/ui/console/index.html#/llm/token-plan>
- 控制台模型广场：<https://www.scnet.cn/ui/console/index.html#/llm/models>
- 商城（购买入口）：<https://www.scnet.cn/ui/mall/>

## 12. 登录接口（账号密码，桌面客户端同款）

额度接口需要控制台登录态；插件通过 SCNet 桌面客户端使用的登录接口获取会话 Cookie，
不需要开发者工具，也不需要用户手动复制。

| 步骤 | 请求 | 说明 |
| --- | --- | --- |
| 1 | `GET https://www.scnet.cn/ac/api/auth/isNeedCpatcha.action` | 是否需要图形验证码；实测当前返回 `{"code":"0","data":false}` |
| 2 | `GET https://www.scnet.cn/ac/api/auth/getClientCaptcha.action` | 需要验证码时返回 `data:image/jpeg;base64,…`，同时下发验证码会话 Cookie |
| 3 | `POST https://www.scnet.cn/ac/api/auth/loginDesktopClient.action` | `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`，body：`username=…&password=…&ph=1`（验证码时加 `captcha=…`） |

实测（2026-10-20）：

- 不存在的账号 → `{"code":"1014","msg":"user not exits or password is not correct"}`，同时 `Set-Cookie: jsessionid=…; Path=/; Secure; HttpOnly`；
- 缺参数 → `{"code":"1003","msg":"params not enough: [username] is null"}`（说明字段名是 `username`/`password`，且必须 form-urlencoded，JSON 会被当成空参数）；
- 登录成功后 `jsessionid` 即为 `/acx` 的登录态；插件会先用它读一次
  `/acx/charge/account/currentuser/tokenplan/list` 验证，通过后才写入 dsh 凭据库；
- 密码只用于这一次请求，不保存；凭据库里只有会话 Cookie 字符串。

> 注意：连续失败可能触发图形验证码（`isNeedCpatcha` 变 true）。插件支持展示验证码图片并提交 `captcha` 字段。

### 12.1 短信验证码登录

| 步骤 | 请求 | 说明 |
| --- | --- | --- |
| 1 | `POST https://www.scnet.cn/sso/sendRegisterMessageCode.action` | form-urlencoded：`mobilephoneNum=+86…&captcha=…&t=…&sn=…` |
| 2 | `POST https://www.scnet.cn/ac/api/auth/loginMobileByPhone.action` | form-urlencoded：`mobilephoneNum`、`messageCode`、`createBy=scnet`、`siteCode=sacp`、`invitationCode=`、`fullName=`、`institution=` |

签名规则（从 `Login-CqtlY06x.js` 逐字提取）：

```js
random = 10 位 [0-9a-zA-Z]
t      = Date.now()
captcha = MD5(phone + t + random + "20250207")
```

- 国家码默认 `+86`，字段是 `mobilephoneNum="+86"+手机号`；
- 发码成功码为 `0`（`1004` 亦被前端视为成功）；`1005` 太频繁、`1013` 虚拟号、`1022` 未注册；
- 登录失败码：`1006` 验证码错误、`1009` 验证码失效、`1014` 账号或密码错误；
- 该流程不需要图形验证码；图形验证码只用于账号密码登录。

### 12.2 账号密码登录的加密与验证码

- 公钥（页面内置）：`MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALaXEnbjI6fjy+t9W9AiO/KS0q+b/OZFS+7ykinLbiriUx9P8BcuuHnVbXNiZp5jW70eVGBtX4DhGUPzJa1YT/8CAwEAAQ==`
- 512 位密钥，PKCS#1 v1.5，单块最多 53 字节；`base64(publicEncrypt(password))` 与页面 `JSEncrypt.encryptLong` 对短密码的输出一致；
- `getClientCaptcha` 的 `data` 是图片 data URL，另返回 `captchaKey`；登录时一起提交。

## 13. 每日用量与 token 构成（Token Plan 页的富数据）

真实页面会先取团队账户 ID，再查每日用量（Playwright 拦截实测，2026-10-20）：

```http
GET  /acx/user/users/cluster-user-detail
     → data.accountId = 2099…（团队账户 ID；注意不是 user.id）
POST /acx/charge/consume-query/resource-usage     (JSON)
     {"accountId":"2099…","resourceAccountId":"2111…",
      "startTime":"2026-10-19 09:21:29","endTime":"2026-11-19 23:59:59"}
     → {"code":"0","data":[
         {"accountId":"2099…","date":"2026-10-19","chargeItem":"TOKENPLAN",
          "sumUsage":"15839.336059","inputTokens":3047974,
          "cachedTokens":30931040,"outputTokens":192620}, …]}
```

- `accountId` 来自 `cluster-user-detail`，`resourceAccountId` 来自订阅行；
- `sumUsage` 是当日消耗的 Credits（字符串小数）；
- `cachedTokens` 是缓存命中的输入 token，**与 `inputTokens` 并列统计，不是其子集**（官方弹层也是分三行展示）；
- `chargeItem` 为 `TOKENPLAN`；官方前端另有 `LLMAPI-INPUT/CACHED/OUTPUT` 映射用于其他套餐；
- 日历热力图：按订阅起止日逐天铺格子，`level = ceil(dayCredits / maxDayCredits * 5)` 并 clamp 到 1–5，周期外为 0；
- 官方页面还支持 `modelName` 过滤（"全部模型"时不传该字段）。
