# DSH plugin platform reference (Web UI plugins, host route, credentials)

Verified against the **running** build: dsh `0.2.1-rc.2` (commit `332895e0f7c9d4dbfb29729f5eb367fa263ff986`), Node `24.21.0`,
profile `desktop` at `~/.dsh/profiles/desktop`, Web GUI `http://127.0.0.1:57386`.
Everything below was read out of the installed plugins and out of the platform SDK inside the running app; nothing is guessed.

## 0. Where the evidence lives

| Source | Path | Notes |
|---|---|---|
| Installed reference plugins | `~/.dsh/profiles/desktop/node_modules/{dsh-ai4scholar,@ggboy123/dsh-paper-reader,dsh-skill-starter,dsh-mimir}` | real third-party plugins |
| Profile composition | `~/.dsh/profiles/desktop/{package.json,cordis.patch.yml,cordis.yml,pnpm-workspace.yaml}` | profile manifest + user patch layer |
| Platform SDK (authoritative) | `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai/*` | read-only extraction of `app.asar`; 307 packages. Paths in text below are package-relative, e.g. `dsh-client-ui-renderer/lib/client.js`. Re-extract with `npx @electron/asar` if `/tmp` is wiped — inside the archive shell tools cannot read it. |
| Official plugin-authoring skill | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` (`SKILL.md`, `references/{host-plugin,ui-plugin,practices,verification,user-actions}.md`, `templates/decoration/*`) | shipped with the app; the templates are the canonical minimal example |
| Loader patch dialect | `@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/SKILL.md` | `insert` / override-by-id / `disabled` / `!!js` / `isolate` |
| Live inspectors | `cordis_inspect_query` (host `Service`, host `Config`, client `Slots`/`Theme`) | host queries work in this session; **client queries timed out**: no page is attached to the client-inspect channel right now. Client facts below come from the same data the inspector serves (`dsh-cordis-client-runner/lib/client.js` `SLOT_CATALOG`, ~line 2400+), which is generated from the shipped slot contracts. |

Two installed plugins are **hand-written, never bundled** — this settles the "no bundler required" question:
`@ggboy123/dsh-paper-reader/lib/client.js` (1703 lines, `window.__ModuleLoader__.load({...})`, header comment: "浏览器源码，直接分发，不经任何构建步骤重写") and
`dsh-skill-starter/client.js` ("浏览器源码，直接分发，不经任何构建步骤重写"). The official template `templates/decoration/client.js` is equally plain JS.

---

## 1. Host half: package.json, patch, module contract, effects

### 1.1 package.json

Copy `templates/decoration/package.json` and add the plugin's own fields. Minimal, working shape:

```json
{
  "name": "dsh-scnet-plan",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "engines": { "node": ">=22.19.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-settings"]
    }
  }
}
```

Field semantics, all enforced in code:

- `dsh.bundle.patch` — one path or an ordered list of paths; read by `bundlePatchFiles()` (`@deepseek-ai/dsh-app-boot/lib/index.js:517`); non-string entries throw `dsh.bundle.patch must be a file path or a list of file paths`. A package listed in `dsh.profile.bundles` **without** `dsh.bundle` throws and is skipped (`loadProfileDirectory`, same file ~1030).
- `dsh.client.platform` — must be `"web"`, otherwise the package contributes no browser bundle (`dsh-client-modules/lib/index.js:733`: `if (decl === void 0 || decl.platform !== "web") … return null`). Every shipped package uses `"web"`.
- `dsh.client` also accepts `immediately` (boolean) and `external` (string[]). `inject`/`external` are validated as string arrays (`parseDshClient`, `dsh-client-modules/lib/client.js:60-77`).
  - `inject` = **package ids** whose client bundles must arrive (register factories) before yours; it does *not* inject services. Unknown package ids are ignored at load.
  - `external` = package ids that must be *loaded and materialized* before yours; it also orders the graph (`orderByModuleGraph`) and is what you should declare when you `require()` another plugin's exports.
  - **`immediately: true` is only a prefetch hint** (`prefetchImmediateTier()`): every graph row is still in the initial "application" batch and mounted at boot (`compose()`, `dsh-client-modules/lib/index.js:659-668`).
- `exports["./client"]` — required whenever `dsh.client` is declared; must be a string or an object with a string `default` (`clientExportOf`, `dsh-client-modules/lib/index.js:172-184`). Missing it throws `declares dsh.client but exports no "./client" bundle`.
- `exports["."]`, `main` — the host entry. The loader imports the row's `name` specifier directly (`Loader.import`, `cordis-plugin-loader/lib/index.js:214`), so `exports["."]` alone is enough for a bare package name.
- `dsh.client.inject` values are **not** dependencies: the profile installs no peers (`pnpm-workspace.yaml` sets `autoInstallPeers: false`). They only have to exist in the boot graph. Unknown names are silently skipped (`arriveGraphRow` only follows ids present in `graphRows`), so a stale list is harmless but useless — the real plugin here lists `@deepseek-ai/dsh-client-runtime`, which is **not a package in 0.2.1-rc.2**; `@deepseek-ai/dsh-client-locale` and `@deepseek-ai/dsh-client-modules` are, while `@deepseek-ai/dsh-client-ui-slots` lives in the seed table rather than as a graph row. Service readiness never comes from this list — it comes from `exports.inject`.
- `name` is load-bearing three times: the loader row's `name` resolves to it, the browser bundle's `id` must equal it, and the `__ModuleLoader__` factory must register under it. Paper-reader's comment says it outright: "必须等于 npm 包名：浏览器端 loader 按包名期待注册（改名时漏改这里 → "loaded without registering" 整页插件加载失败，实测）".

### 1.2 cordis.patch.yml insert shape

A bundle patch is a **top-level YAML array of patch mappings**. An insert row is:

```yaml
# scnet-plan/cordis.patch.yml
- insert:
    - id: scnet-plan                 # patch id = settings namespace (see §4) — must be unique tree-wide
      name: 'dsh-scnet-plan'  # PACKAGE NAME (not a path) — resolved through node_modules
      config:                        # optional; replaces the plugin's Config defaults wholesale
        apiBase: https://api.scnet.cn
        apiKeyEnv: SCNET_API_KEY
```

Rules (from `cordis-composition-reference/SKILL.md`, confirmed in `dsh-app-boot`):

- `insert: [rows]` appends rows; **row `name` is a package specifier**. A *relative* name is anchored beside the patch file, so `name: './index.js'` works for a self-contained dev bundle.
- A patch with `id` and no `insert` **overrides** the existing row with that id. Fields replace the row's fields, and `config` is replaced **wholesale** — never deep-merged — so restate every key you keep. `disabled: false` is how a user re-enables a row a bundle ships disabled.
- Row fields: `id`, `name`, `config`, `disabled`, `inject`, `intercept`, `isolate`, `group`.
- `group: true` + `name: cordis:group` makes `config` a nested entry list; an insert with `id` naming a group appends inside it.
- `!!js` scalars are loader expressions, evaluated against the plugin's context after its declared injections activate (e.g. `!!js "!ctx.get('profileContext')"`).
- Non-insert patches without a non-empty `id`, and targets matching no row, are warned about and skipped.

Composition order (`@deepseek-ai/dsh-app-boot/lib/index.js:485-503`): each bundle's patch list in `dsh.profile.bundles` order over an empty tree → the profile's own `cordis.patch.yml` → `--patch` overlays.

### 1.3 Module contract

`dsh-plugin-development/references/host-plugin.md` allows exactly two shapes (do not mix):

```js
// A) function plugin  — what scnet-plan should use
export const name = 'scnet-plan'            // loader diagnostics / fiber name
export const inject = ['tools']             // services required before apply(); optional
export const Config = Schema.object({ ... }) // @deepseek-ai/schemastery; optional
export function apply(ctx, config) { /* register everything here */ }

// B) default-exported Service class (provides a cordis service)
```

- `name` becomes the fiber name and shows in loader diagnostics; the plugin still works without it, but export it.
- `inject` is the **service** list (cordis keys such as `tools`, `webServer`, `commands`, `systemPrompt`, `settings`), *not* package names. Anything optional goes in `ctx.inject([...], cb)` instead, so the plugin stays inactive in profiles that lack the service.
- `Config` is validated by the loader at activation; `config` passed to `apply` is the validated object with defaults applied. The same schema is what the Settings/Plugin-Manager UI renders — inspect it live with `cordis_inspect_query {platform:"host", provider:"Config", method:"listConfigs", input:{name:"<pkg>"}}`, then query the returned `entry` for the full JSON Schema. Confirmed working for `dsh-ai4scholar`:
  `{"entries":[{"id":"include:ai4scholar","patchId":"ai4scholar","name":"dsh-ai4scholar","status":"schema"}],"total":1}`.
- ESM only for this plugin (`"type": "module"`). The loader normalizes default/CJS shapes (`unwrapExports`, `cordis-plugin-loader/lib/index.js:666`) but a plain ESM `apply` export is the path of least resistance.

**Which bare specifiers are safe to import.** The profile's `node_modules` deliberately contains only what the profile installed. It has **no `@deepseek-ai/dsh-tools`** — yet `dsh-ai4scholar/lib/tools/credits.js:7` does `import { defineTool } from '@deepseek-ai/dsh-tools'` and works (its tools are callable in this very session). The mechanism is the runtime module-resolution interception:
`PluginPackages` is mounted with the profile resolution (`dsh/lib/profile-boot-C14i-8IN.js:306`, `hostCtx.plugin(PluginPackages, { resolution })`), whose constructor installs the interception (`dsh-app-boot/lib/index.js:1846` `installRuntimeInterception`, called from the service at ~3501), and the router (`routeScoped`, `dsh-app-boot/lib/index.js:1613+`) routes a bare request from any importer under the profiles tree to the installation's package directory.

Practical rule:

- ✅ `node:*` builtins; `@deepseek-ai/schemastery` (also installed in the profile); any package in the installation's closure — including `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials`, `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-storage-domain`.
- ✅ packages you declare in your own `dependencies` (pnpm installs them into the profile; local installs win over the installation).
- ❌ anything else. The route table only falls back for names present in the installation closure or the profile; an unknown bare specifier fails with Node's normal resolution error. `peerDependencies` alone install nothing (`autoInstallPeers: false`).
- Version truth: for platform packages the **installation's** copy wins; a profile-installed copy of the same name takes precedence for the profile layer, but a replacement the running process cannot adopt is refused with `profile resolution: replacing "<name>" requires a process restart` (`dsh-app-boot/lib/index.js:1550`).

### 1.4 Effect / disposal rules

From `practices.md` and cordis itself (`@deepseek-ai/cordis/lib/index.js:1169` `effect(execute, label)`):

- Register **every** resource inside `apply` as an effect: `ctx.effect(() => webCtx.webServer.register({...}), 'scnet-plan: snapshot route')`. The plugin fiber owns it; unloading/disabling the plugin, a profile patch change, or an HMR swap disposes it.
- `ctx.effect` accepts a disposer, `null`, a thenable, a sync iterable, or an async iterable of disposers; iterable disposers run in reverse.
- `ctx.on(event, fn)` is also fiber-scoped. Bare `addEventListener`, `setInterval`, and module-level side effects are **not** disposed — do not use them.
- `ctx.inject([...services], cb)` starts a child fiber that activates only when those services exist and is disposed with the parent; use it for `webServer`, `commands`, and `settings`.
- Returning a disposer from `apply` is not a thing in this loader contract — use `ctx.effect`.
- Registrations outside your own fiber (e.g. on `agent.ctx`) need their disposer retained in your own effect as well.

A minimal host half that satisfies all of the above:

```js
// scnet-plan/index.js
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'scnet-plan'
export const inject = ['tools']

export const Config = Schema.object({
  apiBase: Schema.string().default('https://api.scnet.cn').description('SCNet API origin.'),
  apiKeyEnv: Schema.string().default('SCNET_API_KEY').description('Credential reference holding the SCNet API key.'),
  cacheTtlMs: Schema.number().default(60_000).description('Snapshot cache lifetime in milliseconds.'),
})

const ROUTE = '/scnet-plan/snapshot'
const REFRESH_ROUTE = '/scnet-plan/refresh'

export function apply(ctx, config) {
  const ref = credentialRef(config.apiKeyEnv)
  const apiKey = async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = process.env[ref]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  let cache = { at: 0, value: undefined }
  const snapshot = async (signal, force = false) => {
    if (!force && cache.value !== undefined && Date.now() - cache.at < config.cacheTtlMs) return cache.value
    const key = await apiKey()
    if (key === undefined) return { ok: false, code: 'MISSING_KEY', error: 'SCNet API key is not configured' }
    try {
      const res = await fetch(`${config.apiBase}/api/plan/snapshot`, { headers: { Authorization: `Bearer ${key}` }, signal })
      if (!res.ok) return { ok: false, code: `HTTP_${res.status}`, error: `SCNet returned HTTP ${res.status}` }
      cache = { at: Date.now(), value: { ok: true, data: await res.json() } }
      return cache.value
    } catch (error) {
      return { ok: false, code: 'REQUEST_FAILED', error: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' })
          res.end(JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED' }))
          return
        }
        const controller = new AbortController()
        req.once('close', () => controller.abort())
        const body = await snapshot(controller.signal)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      },
    }), `webServer.register(${ROUTE})`)

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: REFRESH_ROUTE,
      handler: async (req, res) => {
        // State-changing route: require a header a cross-site form cannot set, and check the method.
        if (req.method !== 'POST' || req.headers['x-scnet-plan-action'] !== '1') {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, code: 'FORBIDDEN' }))
          return
        }
        const body = await snapshot(undefined, true)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      },
    }), `webServer.register(${REFRESH_ROUTE})`)
  })

  ctx.tools.register(defineTool({
    name: 'scnet_plan_snapshot',
    description: 'Read the current SCNet compute-plan snapshot for the configured SCNet API key.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(_args) {
      const body = await snapshot(undefined)
      if (body.ok !== true) throw new Error(body.error ?? 'SCNet snapshot failed')
      return { summary: JSON.stringify(body.data).slice(0, 2000) }
    },
  }))
}
```

---

## 2. HTTP route: `ctx.webServer.register` (verified, copy from ai4scholar)

Service contract from the live host inspector (`Service.listService {service:"webServer"}`):

```ts
register(route: WebRoute): () => void
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

- Returns the **disposer** that removes the route. A duplicate `(kind, path)` **throws** — "route patterns are a composition-level contract, so a collision is a misconfiguration".
- Matching: exact over the whole table → longest prefix → the single fallback handler (the SPA dist server). While no fallback is registered the server answers 404.
- Other members: `getOrigin()`, `registerUpgrade({path, handler})`, `registerFallback(handler)` (one owner; a second throws), `tapIndex(html => html)`, `applyIndexTaps`, `collectIndexInjections`, `renderIndex`.

The real, working registration — `dsh-ai4scholar/lib/tools/credits.js:127-159` (comment included because it documents the remount trap):

```js
export function applyCreditsTools(ctx, runtime, command, tool, route) {
    if (route) {
        // `webServer` exists only in the web composition; headless never activates this child.
        ctx.inject(['webServer'], (webCtx) => {
            // `register` returns the disposer that removes the route, and a duplicate
            // `(kind, path)` pair throws. Hand the disposer to the fiber: a hot remount
            // (dshmarket toggling the plugin, a settings change) tears the old fiber
            // down and builds a new one, and without this the dead fiber's route was
            // still registered when the new one tried — `webserver: duplicate exact
            // route "/ai4scholar/balance"`, which killed the remount.
            webCtx.effect(() => webCtx.webServer.register({
                kind: 'exact',
                path: BALANCE_ROUTE,
                handler: async (req, res) => {
                    if (req.method !== 'GET') {
                        res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'GET' });
                        res.end(JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'GET only' }));
                        return;
                    }
                    const controller = new AbortController();
                    req.once('close', () => { controller.abort(); });
                    let body;
                    try {
                        body = await answerBalanceRoute(runtime, controller.signal);
                    }
                    catch (error) {
                        body = { ok: false, code: 'REQUEST_FAILED', error: error instanceof Error ? error.message : String(error) };
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                    res.end(JSON.stringify(body));
                },
            }), `webServer.register(${BALANCE_ROUTE})`);
        });
    }
    …
```

`BALANCE_ROUTE = '/ai4scholar/balance'` lives in one shared module `lib/shared/balance-route.js` used by both halves, so the string cannot drift.

**How the browser reaches it** — same-origin relative `fetch`, from `dsh-ai4scholar/lib/client.js:14-38`:

```js
const BALANCE_ROUTE = "/ai4scholar/balance";
const fetchBalanceRoute = async (signal) => {
    const res = await fetch(BALANCE_ROUTE, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        ...signal !== void 0 ? { signal } : {}
    });
    if (!res.ok) return { ok: false, code: `HTTP_${res.status}`, … };
    return await res.json();
};
```

**Auth considerations (important).**

- `dsh-host-webserver` is "a `node:http` server that knows no harness concepts". It ships **no authentication, no session check, and no CORS headers** on plugin routes. The shipped composition binds loopback (`host: 127.0.0.1`), so a plugin route is reachable by any local process and by a cross-origin page's *simple* requests; because no `Access-Control-Allow-Origin` is emitted, a cross-origin page cannot *read* the response, but it can still cause side effects.
- Therefore: return only non-secret data; never echo the API key or any credential value; make state-changing routes `POST` and require a custom header a cross-origin form cannot set (skill-starter uses `x-dsh-skill-starter-action: '1'`, `dsh-skill-starter/index.js:26` + `client.js:264-268`); check `req.method` and answer `405`/`403` with JSON.
- The authenticated surface is the `/api` RPC bridge (`ctx.connection` / `typertGateway`, trust + Peer admission), **not** named webServer routes. `ctx.connection.fetch.register(...)` (skill-starter) is the alternative seam if you want to live under `/api`; it registers `{ path, methods, requestBody, fetch }` and the browser fetches a *document-relative* path (`new URL('api/dsh-skill-starter/manage', document.baseURI)`). For scnet-plan the task specifies `ctx.webServer.register` — keep the custom-header discipline.
- `ctx.webServer.getOrigin()` returns e.g. `http://127.0.0.1:3080`; it throws before the listener binds. Not needed for same-origin fetches.

---

## 3. `ctx.credentials`: exact types, env fallback, browser safety

Service contract (`Service.listService {service:"credentials"}`; types are the inspector's verbatim declarations):

```ts
resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>   // { value: string; source: string }
describe(ref: CredentialRef): Promise<CredentialInfo>                   // { configured: boolean; source?: string; writable: boolean }
set(ref: CredentialRef, value: string): Promise<void>                   // empty value rejected
unset(ref: CredentialRef): Promise<void>
// record half: readRecord / describeRecord / listRecords / modifyRecord / deleteRecord keyed by CredentialKey "<scope>/<id>"
```

- `CredentialRef` is a branded string validated by `credentialRef(value)` against `/^[A-Za-z_][A-Za-z0-9_]*$/` (`@deepseek-ai/dsh-credentials/lib/index.js:19-30`). A bad name throws `TypeError`. `isCredentialRefName(value)` is the non-throwing probe.
- Resolution is **per operation, never cached across operations** — that read is the hot-rotation mechanism.
- A stored value outranks the environment; an empty stored value counts as absent everywhere.
- `describe()` never returns the value — it is the only thing safe to forward to the browser.

The reference implementation, `dsh-ai4scholar/lib/runtime.js:68-89` (verbatim):

```js
export function makeCredentialResolvers(ctx, apiKeyEnv) {
    const ref = credentialRef(apiKeyEnv);
    const apiKey = async () => {
        const credentials = ctx.get('credentials');
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            return hit?.value;
        }
        const ambient = process.env[ref];
        return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
    };
    const requireApiKey = async () => {
        const key = await apiKey();
        if (key === undefined) {
            throw new Error(`AI4Scholar API key is not configured. Open Settings → Plugins → AI4Scholar in the dsh web UI, `
                + `or store it as ${ref} in $DSH_HOME/.credentials.yaml (or export ${ref} in the environment that launches dsh). `
                + `Get a key at https://ai4scholar.net?src=dsh`);
        }
        return key;
    };
    return { apiKey, requireApiKey };
}
```

Pattern for scnet-plan: same shape with `ref = 'SCNET_API_KEY'`; `ctx.get('credentials')` (optional access, no `inject` requirement) then `process.env[ref]`. The credential store in this profile is `~/.dsh/.credentials.yaml` (the profile's default provider), with `$DSH_HOME/.credentials.yaml` as the documented location.

**Never expose the key to the browser.** Rules that follow:

- The route returns `{ ok, code, error }` and data only; on a missing key it returns `MISSING_KEY`, never the value.
- For "is a key configured?" use a server route (or `describe`) that answers a boolean plus a masked hint (`…last4`) computed on the host. ai4scholar computes the last-4 hint **host-side** (`credits.js:191`: `configured (…${key.slice(-4)})`) and its browser card only ever calls `describe`.
- Do **not** put `apiKey` in your `Config` — the schema is rendered as a form and stored in `cordis.patch.yml`. Config carries the *reference* (`apiKeyEnv`), the value stays in the credential store.
- Settings/projected forms redact secrets for remote callers (`SettingsDescribeOptions.redactSecrets`), but that only covers schema-declared secrets; a route is still your responsibility.

---

## 4. Settings namespace + `ctx.tools.register`

### 4.1 The ai4scholar settings comment, and why it does not apply to this build

`dsh-ai4scholar/lib/index.js:169-181` (verbatim), written for dsh 0.1.0-rc.7:

```js
    // From dsh 0.1.0-rc.7 the Settings → Plugins tab renders the intersection
    // of two ledgers: cards registered under `settings.plugin.item` and the
    // namespaces the Host's settings service serves. The card is in the browser
    // bundle; this is the other half — a namespace whose only job is to make
    // "ai4scholar" a served key, so the key card keeps appearing. The API key
    // itself stays in the credentials store and never enters settings. On rc.6
    // and earlier the tab rendered every card unconditionally and this
    // registration is inert; in a deployment with no settings service the
    // callback simply never runs.
    ctx.inject(['settings'], (settingsCtx) => {
        const service = settingsCtx.settings;
        service.register('ai4scholar', Schema.object({}).description('AI4Scholar — configured through its Settings card; the API key lives in the credential store.'));
    });
```

**In the running build (`dsh-settings` 0.2.1-rc.2) there is no `settings.register` at all.** Verified three ways:

1. `Service.listService {service:"settings"}` lists only `configure`, `prepareDocument`, `describe`, `update`, `replace`, `mutate`.
2. `grep -rn "settings.register" over all 307 platform packages` → no hits.
3. The Settings → Plugins composition changed shape: the old keyed `settings.plugin.item` slot **does not exist** in this build's slot catalog, and `grep -rn "settings.plugin.item"` over the platform finds no declaration (only the third-party ai4scholar bundle still registers into it — `dsh-ai4scholar/lib/client.js:956` — so that registration waits forever and its card cannot render).

What replaces it:

- **Settings namespaces are loader entry ids.** `dsh-settings/lib/index.js:432` and `443`: `ns: entry.options.id`, and the entry set comes from `ctx.configEditor.configuration()`, which enumerates the rows under the root include and **drops duplicated ids** (`dsh-config-editor/lib/index.js:30-34`). So the *patch row `id`* is the settings namespace and the key `settings.update(ns, patch, revision)` takes. `Config.listConfigs` shows both spellings: `id: "include:ai4scholar"`, `patchId: "ai4scholar"` — the namespace is the **patchId**.
  → Consequence for scnet-plan: pick a unique row id (`scnet-plan`), export a `Config`, and the auto-generated configuration form appears (rendered by the Plugin Manager page through `ctx.configForms.describe()/get(id)`, `dsh-client-ui-plugin-manager/lib/client.js:1030-1034`) **with no host-side registration at all**.
- **A custom settings card is a slot, not a namespace.** Register into `settings.section` (list, root scope; one nav entry per registration) for a whole page, or `settings.plugins.tab` (list) for a tab inside the built-in Plugins section, or `settings.general.item` for a single preference row. There is no host-side "counterpart" call to make in this build; `settings.configure({ auto: false })` only opts *out* of the auto page.

### 4.2 `ctx.tools.register` shape

`ctx.tools.register(definition): () => void` (`Service.listService {service:"tools"}`). Definitions come from `defineTool`:

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'scnet_plan_snapshot',              // model-facing, unique
  description: '…',                          // model-facing
  parameters: {                              // typed DSL: string|number|integer|boolean|null|array|object|json|oneOf
    query: { type: 'string', required: true, description: '…' },
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { /* … */ } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  timeoutMs: 30_000,                         // declarative only (see below)
  isConcurrencySafe: (args) => true,
  presentCall: () => ({ card: 'generic', title: 'SCNet plan', kind: 'read' }),
  async execute(args, exec) {                // exec: { signal, agent, arguments, callId, name, token,
    return doWork(args, exec.signal)         //        parent, rootCallId, schema, concludeTurn, deferContext }
  },
}))
```

- Arguments are validated against `parameters` before `execute`; violations become a normal error result.
- `execute` must return exactly the declared output value; the returned disposer of `ctx.tools.register` removes the tool (register it through `ctx.effect`/directly in `apply` — both are fiber-scoped).
- `timeoutMs` is **not enforced** by the registry; enforcement requires `@deepseek-ai/dsh-tool-call-timeout-policy`. Pass `exec.signal` to your fetch calls regardless.
- The registry feeds the model's schema automatically — no extra prompt registration. Optional extras seen in ai4scholar: `ctx.systemPrompt.section({name, order, text})`, `ctx.commands.register({name, description, handler})` (inside `ctx.inject(['commands'], …)`).

---

## 5. Client bundle format — exact

### 5.1 The wrapper

Every browser bundle is one classic script that registers a lazy factory. There is exactly one accepted shape:

```js
window.__ModuleLoader__.load({
  id: '<exact package name>',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });   // optional (tsdown emits it)
    const React = require('react');
    const h = React.createElement;
    // … component definitions …
    function apply(ctx) { /* registrations */ }
    const inject = ['slots', 'locale', 'layout'];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

- `id` is normalized by `stripClientSuffix` (`dsh-client-modules/lib/client.js:98`): `<pkg>` and `<pkg>/client` are the same module. **It must equal the package name** — the loader looks the factory up by graph row id and otherwise fails with `loaded without registering "<id>" via __ModuleLoader__.load` (`lib/client.js:758`), which fails that plugin's load (and cascades to its dependents).
- A second registration of the same id throws `duplicate factory registration for "<id>" (bundle executed twice without invalidate?)` (`register()`, `lib/client.js`).
- `factory` runs **once, lazily, on first import and is memoized**. Keep it side-effect free except defining components; do all registration in `apply`.
- Package-local dynamic chunks are optional and not needed for scnet-plan. A chunk is a separate file beside the bundle that registers itself as `window.__ModuleLoader__.load({ id: '<same package name>', chunk: 'client.foo.js', factory })`; the file name must match `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`, and consumers load it with `await require.async('./client.foo.js')` (`register`/`makeRequire`/`importChunk`, `dsh-client-modules/lib/client.js:98, 832, 852`).
- `exports.apply(ctx)` and `exports.inject = [...]` are the exported plugin face the client cordis Loader mounts. `inject` names **client services** (`slots`, `locale`, `layout`, `theme`, `remote`, `sessions`, …); the entry is created with a bare `{ name: id }` (`ClientEntries.create`, `dsh-client-modules/lib/client.js:483`), so `dsh.client.inject` (packages) and `exports.inject` (services) are different things.
- Hand-written works: `@ggboy123/dsh-paper-reader/lib/client.js` and `dsh-skill-starter/client.js` are shipped unbundled; the official template is too. No bundler, transpiler, or JSX is required — use `React.createElement`/`h`.
- Styles: emit a `<style>` (e.g. `document.head.appendChild(style)`) inside an effect so disposal removes it; the module system tags and reclaims styles per plugin for HMR. `dsh-ai4scholar` does `ctx.effect(() => installStyles(), 'ai4scholar: settings card styles')` (`lib/client.js:929`), paper-reader appends two id-guarded `<style>` elements in `apply` (lines ~1620-1640).

### 5.2 Allowed `require()` specifiers — the complete static table

The page hands the module system a fixed seed table (`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`, `function SZ()`):

```
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
zod
@tanstack/react-virtual
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

Plus, in the same `require`: any *other registered package factory* (i.e. another plugin's `exports`, reached by its package name or `<pkg>/client`), and `require.async('./chunk.js')` for your own chunks. Anything else throws `require("…") missed the module table`.

**Do not require `@deepseek-ai/dsh-client-ui-primitives`** (or any client package) — `practices.md` is explicit: they change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (`slot entry crashed in '<slot>'`). Copy the markup/CSS you need and style with theme tokens. ai4scholar only uses `react` + `react/jsx-runtime`; paper-reader additionally uses `react-dom` (`createPortal`).

### 5.3 Slot registration: `inject` then `register`

```js
ctx.slots.inject('<slot key>', () => ctx.slots.register(
  { name: '<slot key>', id: '<unique id>', order: 100, label: () => t('label'), locale: NS, inject: () => ({…}) },
  Component,
))
```

- `slots.inject(key, cb)` runs `cb` **now** if the slot is already declared, otherwise inside the declaring `register()` the moment the declaration is committed; the callback's registrations are disposed when the declaration collapses (e.g. the Settings panel closes) and **reinstalled when it returns**. It returns an idempotent disposer owned by your fiber. This is why the pattern is mandatory rather than optional: `settings.section` only exists while the settings shell is mounted.
- `slots.register(options, component)` returns the entry disposer. Register it *inside* the `inject` callback; the `inject` controller already owns the lifetime, and `register`'s own effect routes through your fiber (`SlotRegistry._register` → `ctx.effect`).
- `options.name` is the slot key and must match. Kinds and their required options (`SlotCore.register`, minified but readable in the shipped frontend bundle; catalog in `dsh-cordis-client-runner/lib/client.js`):
  - `single` — no key; a second registration **at the same priority throws** — "register at a different priority to shadow it (lowest renders)".
  - `keyed` — **`key` required**; one entry per `(key, priority)`.
  - `list` — **`id` required**; additive; one entry per `(id, priority)`.
  - `chain` — **`select` required**; pure routing selector, entries tried ascending, first non-null wins and arrives as the `matched` prop.
  - Common: `order` (ascending render position), `label` (`string | () => string`; a thunk is re-read on every projection, so localize through it), `priority` (default 0; lowest wins a shadowed cell), `locale` (namespace string), `inject` (your props face), `children` (declare child slots), `store` (a store handle → `useStore`/`actions` props), `registrant` (diagnostic stamp, set for you).
- Props a component receives (`ContextualEntry`, `dsh-client-ui-renderer/lib/client.js:780-790`):
  `{ …standard hooks, renderFactorySlot, [t], [useStore], [actions], [renderSlot], [SessionProvider] } + your inject face (hooks map becomes `useX` selectors) + owner props (owner wins)`.
  `locale: NS` is what produces `props.t`; `inject: () => ({ hooks: { card: store }, save() {} })` produces `props.useCard` and `props.save()` (ai4scholar `lib/client.js:938-955`). Standard hooks are listed per slot in the catalog (`useSession`, `useChat`, `useConversation`, `usePanelInfo`, `useWorkspaces`, `useSessions`, `useResource`, …).

### 5.4 Real snippets per slot (copy the shape, not the content)

**`settings.section`** — one whole page. `dsh-skill-starter/client.js:627-641` (simplest real example):

```js
function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skill-starter: section dictionaries')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-skill-starter',
    order: 57,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t, locale: ctx.locale }),
  }, Panel))
}
return { inject: ['slots', 'locale'], apply }
```

`@ggboy123/dsh-paper-reader/lib/client.js:1653-1658` is the same call with `inject` omitted; its `SettingsPanel` just reads `props`/`t`. Owner props for this slot: `{ close: () => void }`.

**`settings.plugins.tab`** — one tab inside Settings → Plugins (`dsh-client-ui-settings-plugin-inventory/lib/client.js:758-766`):

```js
ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
  name: 'settings.plugins.tab', id: 'all', order: 10, label: () => t('tab'), locale: NS, inject: injected
}, PluginInventorySettingsTab))
```

**`main`** (keyed panel) + **`sidebar.panellist`** — the canonical pair, `dsh-client-ui-plugin-manager/lib/client.js:4355, 4417-4432, 4477-4484`:

```js
const PANEL_ID = 'plugins'
ctx.slots.inject('main', function* () {
  const handle = createNavigationStore(), instance = handle.create()
  const store = { ...handle, create: () => instance }
  yield ctx.slots.register({
    name: 'main', key: PANEL_ID, locale: NS, store, inject: () => face,
    children: { 'plugins.tab': { kind: 'list', scope: 'root' } },
  }, PluginManagerPage)
  yield () => { disposeNavigation() }
})
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: PANEL_ID, order: 0, label: () => t('panel'), locale: NS
}, PluginsPanelIcon))
// icon: function PluginsPanelIcon({ size }) { … }   // owner props: { size: number; active: boolean }
```

**`sidebar.footer.action`** (list, root; always-visible row in the sidebar foot) — `dsh-mimir/lib/client.js:37125-37131`:

```js
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action', id: 'research', order: 10, store: panel, locale: NS
}, ResearchToggle))
```

**`shell.overlay`** (list, root; the sanctioned full-frame overlay) — `dsh-mimir/lib/client.js:37150-37156`, and paper-reader's reader overlay (`lib/client.js:1680-1687`):

```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'research', order: 10, store: panel, locale: NS, inject: (actions) => ({…})
}, ResearchOverlays))
```

**`conversation.composer.dock`** (list, **session** scope) — the official template `templates/decoration/client.js`:

```js
ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
  name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
}, Decoration))
```

**`shell.quota-notice`** (chain, root) — requires `select`:

```js
ctx.slots.inject('shell.quota-notice', () => ctx.slots.register(
  { name: 'shell.quota-notice', select: (owner) => owner.code === 'my-code' ? {…} : null },
  MyNotice))
   // owner props: { code, message, dismiss(), keepOpen() }
```

**`sidebar.workspaces` / `sidebar` etc.** — single slots; registering replaces shipped UI (paper-reader takes it over with `priority: -1000`, `lib/client.js:1341-1350`, and only on demand).

**Locale** — `ctx.locale.register(NS, { zh, en })` (or the typed `(ns, dicts)` form) inside `ctx.effect`, plus `const t = ctx.locale.bind(NS)` for code outside components; components get `props.t` via `locale: NS`. Registration bumps the locale revision so mounted outlets re-render with late-arriving dictionaries.

**Disposal**: everything above is an effect on the plugin fiber. `slots.inject`'s controller, the entry disposer it creates, `locale.register`, `theme.overrideTokens`, style tags, and timers all disappear when the plugin unloads or HMR-swaps it. Verify by unloading the plugin (Plugin Manager toggle) and confirming the sidebar icon/page/composer chip are gone.

### 5.5 Complete minimal `scnet-plan/client.js` (hand-written, no bundler)

```js
// scnet-plan/client.js — classic script, no build step. `id` MUST equal the package name.
window.__ModuleLoader__.load({
  id: 'dsh-scnet-plan',
  factory: require => {
    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'scnet-plan'
    const PANEL = 'scnet-plan'
    const ROUTE = '/scnet-plan/snapshot'

    const zh = { panel: 'SCNet 算力计划', refresh: '刷新', missing: '未配置 SCNET_API_KEY', failed: '读取失败', chip: '算力' }
    const en = { panel: 'SCNet plan', refresh: 'Refresh', missing: 'SCNET_API_KEY is not configured', failed: 'Could not read the plan', chip: 'Budget' }

    /** Same-origin GET of the host route; never carries a key. */
    const fetchSnapshot = async (signal) => {
      const res = await fetch(ROUTE, { method: 'GET', credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}) })
      return await res.json()
    }

    const CARD = {
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-md)',
      padding: '12px 14px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
    }
    const BTN = {
      fontSize: '13px', padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
      background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
    }

    /** Main panel: reads the route itself; owner props for `main` are non-session. */
    function ScnetPanel(props) {
      const [snap, setSnap] = useState({ state: 'loading' })
      const load = useCallback(() => {
        const controller = new AbortController()
        setSnap({ state: 'loading' })
        fetchSnapshot(controller.signal)
          .then(body => setSnap(body.ok === true ? { state: 'ready', data: body.data } : { state: 'error', body }))
          .catch(() => setSnap({ state: 'error', body: { code: 'REQUEST_FAILED' } }))
        return () => controller.abort()
      }, [])
      useEffect(load, [load])
      const t = props.t
      if (snap.state === 'loading') return h('div', { style: CARD }, '…')
      if (snap.state === 'error') {
        const body = snap.body || {}
        const text = body.code === 'MISSING_KEY' ? t('missing') : `${t('failed')}: ${body.error || body.code || ''}`
        return h('div', { style: { ...CARD, color: 'var(--dsw-alias-state-error-primary)' } }, text)
      }
      return h('div', { style: CARD },
        h('h3', { style: { margin: '0 0 8px', fontSize: '14px' } }, t('panel')),
        h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', fontSize: '12px' } }, JSON.stringify(snap.data, null, 2).slice(0, 2000)),
        h('button', { type: 'button', style: { ...BTN, marginTop: '10px' }, onClick: load }, t('refresh')))
    }

    /** Sidebar button: owner props are { size, active }; clicking selects the `main` key with the same id. */
    function PanelIcon({ size, active }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
      }, h('rect', { x: 3, y: 12, width: 4, height: 9, rx: 1, fill: 'currentColor' }),
         h('rect', { x: 10, y: 6, width: 4, height: 15, rx: 1, fill: 'currentColor' }),
         h('rect', { x: 17, y: 9, width: 4, height: 12, rx: 1, fill: 'currentColor' }))
    }

    /** Composer dock chip: session-scoped, so it exists only with a session open. */
    function ComposerChip(props) {
      return h('button', {
        type: 'button', 'data-dsh-plugin': 'scnet-plan',
        style: { fontSize: '12px', padding: '2px 8px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l1)', background: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
        onClick: () => props.openPanel(),
      }, props.t('chip'))
    }

    /** Settings page: host §4 explains why no host-side namespace call is needed. */
    function SettingsCard(props) {
      const [body, setBody] = useState(null)
      useEffect(() => { fetchSnapshot(undefined).then(setBody).catch(() => setBody({ ok: false, code: 'REQUEST_FAILED' })) }, [])
      const status = body === null ? '…'
        : body.ok === true ? 'OK'
        : body.code === 'MISSING_KEY' ? props.t('missing') : `${props.t('failed')}: ${body.code}`
      return h('div', { style: CARD },
        h('h3', { style: { margin: '0 0 4px', fontSize: '14px' } }, props.t('panel')),
        h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, status))
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'scnet-plan: dictionaries')
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL, locale: NS, inject: () => ({ t }) }, ScnetPanel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL, order: 20, label: () => t('panel'), locale: NS }, PanelIcon))
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'scnet-plan-chip', order: 20, locale: NS,
          inject: () => ({ t, openPanel: () => ctx.layout.selectPanel(PANEL) }) }, ComposerChip))
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'scnet-plan', order: 72, label: () => t('panel'), locale: NS, inject: () => ({ t }) }, SettingsCard))
    }

    const inject = ['slots', 'locale', 'layout']
    return { inject, apply }
  },
})
```

`node --check client.js` parses this file without a bundler (`window` is never evaluated at parse time).

---

## 6. Opening the keyed main panel

**Yes — you must register the `sidebar.panellist` entry yourself if you want a sidebar button.** The two seats are independent:

- `main` is `keyed`, `scope: root`, declared by an entry in `root` (client-ui-layout) — it exists as soon as the layout root is mounted. Keys: "open: any string the owner dispatches (no compile-time key set), already taken: `conversation`". Registering an already-occupied key **replaces** that occupant (`replaceRisk: shadows-shipped-ui` for `conversation`).
- `sidebar.panellist` is `list`, `scope: root`, declared by an entry in `sidebar` (client-ui-sidebar). Catalog doc: **"Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata."** The sidebar builds its rows from `slots.entriesOfSlot('sidebar.panellist')` mapping `options.id → {id, order, label}` (`dsh-client-ui-sidebar/lib/client.js:454-469`); clicking a row calls `selectPanel(id)` → `ctx.layout.selectPanel(id)` (`:478-480`, `PanelRow` at `:173-201`). The icon component receives `{ size, active }`.
- The layout renders `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })` (`dsh-client-ui-layout/lib/client.js:119`).

Programmatic open — `ctx.layout.selectPanel`:

```ts
selectPanel(panelId: MainPanelId | null): void   // null returns to the Conversation
```

- Throws `layout.selectPanel: main panel "<id>" is not registered` when the live `main` registry has no entry with that key — its check is exactly `ctx.slots.entries('main').some((entry) => entry.options.key === id)` (`dsh-client-ui-layout/lib/client.js:617`, `LayoutController.selectPanel` at `:468-472`). So: register the `main` entry first (via `slots.inject`, at apply time) and only then expose an "open panel" button.
- `retainMainPanels` clears `activePanelId` to `null` when the active key disappears (`:614-615, 689-690`), so removing your panel gracefully falls back to the Conversation.
- `ctx.layout` is a client service: put `layout` in `exports.inject` before using it. Other members: `beginNavigation()`, `toggleSidebar()`, `openRightbar(track, fullscreen)`, `closeRightbar()`.
- A panel opened this way is **not session-bound**: `main`'s standard props are `useRemoteAccess, useResource, useWorkspaces, usePanelInfo, useSessions, useSessionStatus, useSessionRetainInfo, useSessionAccess, useWorkspaceAccess` — there is no `useSession`/`useChat`/`sessionId` for a non-`conversation` key. Read `usePanelInfo((info) => info.activePanelId === '<id>')` to know whether you are showing.

Minimal correct wiring for scnet-plan:

```js
const PANEL = 'scnet-plan'
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'scnet-plan: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL, locale: NS, inject: () => ({ refresh }) }, ScnetPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL, order: 20, label: () => t('panel'), locale: NS },
    ({ size, active }) => h('svg', { width: size, height: size, 'aria-hidden': true, /* … */ })))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'scnet-plan-chip', order: 20, locale: NS }, ComposerChip))
}
```

The composer chip opens the panel with `ctx.layout.selectPanel(PANEL)` (the `layout` service must be in `exports.inject`).

---

## 7. Theme tokens and locale

### 7.1 Token system (from `Theme.listTokens`'s source of truth)

`@deepseek-ai/dsh-client-ui-theme/lib/client.js` ships both palettes as CSS:

- Light: `body { --dsw-alias-*: … }`
- Dark: `body[data-ds-dark-theme] { --dsw-alias-*: … }`
- Static ramps: `--dsw-static-{amber,blue,deepseek,green,neutral,neutral-bluish,red}-<step>`
- Radii/type/motion: `--dsw-radius-{xs,sm,md,lg,xl,panel}`, `--dsw-font-family`, `--ds-font-family-code`, `--ds-transition-duration(-fast|-slow)`, `--ds-ease-in-out`, `--dsw-focus-ring-width`.

High-value alias tokens (exact names; ~107 exist):

```
--dsw-alias-bg-base, -bg-layer-1, -bg-layer-2, -bg-layer-3, -bg-module-platform,
--dsw-alias-bg-overlay, -bg-mask-1, -bg-skeleton
--dsw-alias-border-l1, -border-l2, -border-l3, -border-l4, -border-inverted
--dsw-alias-label-primary, -label-secondary, -label-tertiary, -label-caption,
--dsw-alias-label-primary-foreground, -label-dimmed, -label-primary-inverted, -link
--dsw-alias-button-primary-fill, -button-primary-hover, -button-primary-dimmed,
--dsw-alias-button-ghost-active-fill, -button-elevated-fill, -button-floating-fill
--dsw-alias-interactive-bg-hover, -interactive-bg-active, -interactive-bg-hover-accent,
--dsw-alias-interactive-bg-hover-danger, -interactive-bg-hover-solid
--dsw-alias-state-success-primary/-secondary/-tertiary,
--dsw-alias-state-warn-primary/-secondary/-tertiary/-label,
--dsw-alias-state-error-primary/-secondary, -state-idle-primary, -state-business-primary
--dsw-alias-link, -markdown-code-block, -markdown-inline-code, -toast-bg, -toast-label,
--dsw-alias-tooltip-bg, -scrollbar-bg-l1, -scrollbar-hover-l1, -switch-thumb
--dsw-alias-settings-card-fill, -settings-card-stroke     (settings pages)
--dsw-specific-sidebar-fill, -sidebar-nav-item-hover, -sidebar-nav-item-active,
--dsw-specific-menu, -specific-bubble, -specific-input-major, -specific-tip
```

Rules (`practices.md` UI section): style with `--dsw-alias-*` only; literal colors are for artwork; a renamed token degrades appearance but never breaks rendering. Never hard-code light/dark pairs — both palettes already exist.

Programmatic overrides (client `theme` service, from the catalog):

```js
ctx.effect(() => ctx.theme.overrideTokens('scnet-plan', {
  '--dsw-alias-state-business-primary': { light: '#0a7d54', dark: '#3fd39a' },
}), 'scnet-plan: token overlay')
```

- `overrideTokens(source, tokens)` stacks a per-token layer over the active theme (one layer per source; calling again replaces that source's layer). Values are **`{ light, dark }` pairs** — a bare string throws.
- `ctx.theme.register({ id, colorScheme, tokens })` registers a *selectable theme* instead; duplicate id throws.
- Prefer `overrideTokens` for a panel's accent color; do **not** repaint host surfaces.

### 7.2 `locale.register`

```js
const NS = 'scnet-plan'
const zh = { panel: 'SCNet 算力计划', refresh: '刷新', … }
const en = { panel: 'SCNet plan', refresh: 'Refresh', … }

ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'scnet-plan: dictionaries')
```

- Typed form: `register(ns, dictsKeyedByLocaleId)` registers every built-in locale in one call; duplicate `(ns, locale)` throws; the disposer removes every locale from that call.
- Untyped form: `register(ns, locale, dict)` for language packs.
- `ctx.locale.bind(ns)` returns a stable `t` for non-component code; `locale: NS` on a slot registration gives components `props.t`.
- Pass the namespace string consistently: `NS` should equal the package name by convention (ai4scholar, paper-reader, mimir, skill-starter all do this).
- Plugin *display* metadata (title/description/icon in the Plugin Manager) is separate: `locale/en.json` + `locale/zh.json` with `{"meta":{"title":…,"description":…}}`, exported as `./locale/*.json`, plus `./icon` (SVG/PNG/JPEG/WebP ≤ 256 KiB, inside the package). Missing metadata falls back to `package.json` name/description and generic artwork.

---

## 8. Local development: install, iterate, uninstall

### What the mechanism actually is

- A profile is `$DSH_HOME/profiles/desktop` with `package.json` (dependencies) + `dsh.profile.bundles` (the **ordered list of mounted bundles**) + `cordis.patch.yml` (the user's own patch layer).
- Composition = each selected bundle's `dsh.bundle.patch` files in `dsh.profile.bundles` order, then the profile patch (`dsh-app-boot/lib/index.js:485-503`).
- **`dependencies` ≠ mounted.** A package installed in the profile but absent from `dsh.profile.bundles` is never loaded. The current profile is proof: `dsh-http-debug` and `web-bridge-mcp` are dependencies but not in `bundles`.
- Every install path ends in `pnpm add` in the profile directory. Evidence from `.plugin-manager/logs/*/pnpm.log` (all install runs are pnpm):
  `operation-N6koBk`: `+ @ggboy123/dsh-paper-reader 1.5.1`; `operation-2au3Rf`: `+ dsh-mimir ^0.21.1`; `operation-DNItqU`: `- dsh-ai4scholar 0.3.7`.
  There is no separate "bundle selection" log — selection lands in `package.json`'s `dsh.profile.bundles`.

### Option A (recommended): `plugin_manager install_bundle`

`target` = the **absolute package directory** (`/Users/ronnie/Desktop/Projects/Softwares/DSH_Plugin/scnet-plan`). The tool performs:

1. `pnpm add <abs path>` (pnpm records a `link:` dependency pointing at your checkout, so edits are live without reinstalling),
2. `resolveBundleDir` + `dsh.bundle` presence check (`not-bundle` failure otherwise),
3. version-compatibility check against the runtime,
4. `selectBundle(name, true)` → writes `dsh.profile.bundles`,
5. `publishAndReload(...)` → with HMR present (`ownerContext.get('hmr') !== undefined`) the profile recomposes live and the new rows start; the result's `application` is `applied` (or `restart-required` with `restartReason`).

Read `application`, `warnings`, and `pendingBuilds` from the result — that, not the log, decides whether the change is live. Notes:

- `install_bundle` refuses with `already-installed` when the package is already a dependency and HMR is present — you cannot "install again" to pick up edits. Edit files (client) or restart (host).
- Any `pendingBuilds` require explicit user approval before passing `approvedBuilds`.
- This action needs approval/permission; in this session approval prompts are disabled, so the Lead must run it.

### Option B: `dsh plugin --profile desktop add /absolute/path`

Verified CLI: `dsh plugin --help` → "manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"; `--profile desktop` routes to `runProfilePnpm` (`@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:84-123`).

- **The app must be fully quit first**: I ran it against the live app and got
  `Error: EPERM: operation not permitted, open '/Users/ronnie/.dsh/profiles/desktop/package.json.lock'` from `dsh-atomic-write`, plus the CLI's own guard text "Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop."
- It runs **pnpm only** — it does **not** add the package to `dsh.profile.bundles`. After it, add the package name to that array in `~/.dsh/profiles/desktop/package.json` (or re-run `plugin_manager set_bundle` / `install_bundle` from a profile that does not yet list it), then start the app.

### Option C: manual, no pnpm

Safest when you want zero package-manager involvement:

1. Put the bundle on disk (any directory).
2. Make the row resolvable: either use a relative `name` in a patch (`name: './index.js'` is anchored beside the patch file — works even with no `node_modules` entry), or symlink/copy the directory into `~/.dsh/profiles/desktop/node_modules/<pkg>` (a `link:` style symlink survives; note `loadProfile` calls `removeLinkProjections(dir)`, which only unlinks symlinks pointing into `<profile>/.dsh-module-fallback/node_modules`, so ordinary symlinks are safe).
3. Add to the **profile's own patch layer** `~/.dsh/profiles/desktop/cordis.patch.yml` (the file's own header: "a top-level YAML array of loader patch entries (id-targeted config overrides, disables, and insert lists)"):

```yaml
- insert:
    - id: scnet-plan
      name: 'dsh-scnet-plan'   # or './scnet-plan/index.js' for a path-anchored row
      config: { apiKeyEnv: SCNET_API_KEY }
```

   …**or** add the package name to `dsh.profile.bundles` in the profile `package.json` and let the bundle's own `cordis.patch.yml` insert the row.
4. Restart the Host (manual patch edits are read at boot; the settings/Plugin-Manager write path is what hot-recomposes).

### What needs a restart vs a page refresh

| Change | Effect |
|---|---|
| `client.js`, `client.*.js` chunks, CSS in the bundle | **Live swap, no reload.** `dsh-client-hmr` stat-polls each entry artifact (default `pollIntervalMs: 500`), and a changed mtime/ctime/size publishes a new rev → `/plugins/events` → the browser tears down the old fiber, imports the new bundle, remounts with fresh state. React state inside the plugin is lost; session/workspace state survives. |
| Selecting a new bundle / enabling-disabling a plugin row | Recomposed live through HMR; the page receives the new graph over the event stream. A page reload also works. |
| `index.js` (host half) source edit | **Restart the Host.** The host module is imported once per process ("replacing an installed package requires restart to load a fresh JavaScript module generation"); a fresh install of a *never-imported* module can still activate live through HMR. |
| `cordis.patch.yml` edit by hand | Restart (safest). `plugin_manager`'s own writes recompose live. |
| New `Config` keys | Restart (the row's config is validated at activation). A config *value* change made through the Settings/Plugin-Manager UI applies live (`applies: "live"`). |
| Page refresh alone | Re-fetches the boot graph + all `/plugins/...` bundles; does **not** reload host JS. |

### Uninstall cleanly

- Preferred: `plugin_manager remove_bundle` with the exact bundle name from `list_bundles` — it unloads the plugin, removes the dependency through the same pnpm path, and unregisters the bundle selection. Then restart if the result says `restart-required`.
- Manual: remove the name from `dsh.profile.bundles`, remove any `- id: scnet-plan` override/insert rows you added to the profile `cordis.patch.yml`, delete the dependency from the profile `package.json` (or `dsh plugin --profile desktop remove <pkg>` with the app quit), and delete `node_modules/<pkg>`.
- Residual state to check: `~/.dsh/.credentials.yaml` (your `SCNET_API_KEY` entry does not disappear by itself), any `<profile>/.plugin-manager/logs/*` you no longer need, and a stale `data-dsh-plugin` style element (the module system removes plugin-owned `<style>` tags on unload).

---

## 9. Pitfalls and end-to-end verification checklist

### Pitfalls

1. **Bundle `id` mismatch** → the whole plugin fails to load with `<url>: loaded without registering "<id>" via __ModuleLoader__.load`, and every dependent plugin cascades (`"<consumer>" not loaded because dependency "<id>" failed`). `id` must equal the package name exactly.
2. **Registering a slot that no longer exists.** `slots.inject` for an undeclared key waits silently forever. The known trap in this build is `settings.plugin.item` (only ai4scholar still uses it) — its card cannot render. Always check the slot key exists in the current build's catalog.
3. **`ctx.settings.register` does not exist in 0.2.1-rc.2**; calling it inside `ctx.inject(['settings'], …)` throws in that child fiber (logged, plugin otherwise fine). Not needed: the patch row id *is* the settings namespace, and `Config` gets an auto page.
4. **Duplicate `(kind, path)` webServer route** → `webserver: duplicate exact route "…"`, and a remount without the effect-owned disposer leaves the dead fiber's route registered. Always `ctx.effect(() => webServer.register(...))`.
5. **Single-slot collisions** throw (`already has a registration at priority N (registered by …)`). Additive lists need unique `id`s; use `priority` deliberately (`lowest renders`), as paper-reader does with `-1000` on `sidebar.workspaces`.
6. **`main` without `sidebar.panellist`** is unreachable by mouse; **`sidebar.panellist` without `main`** throws on click (`layout.selectPanel: main panel "<id>" is not registered`).
7. **Session-scoped seats disappear off-session.** `conversation.composer.dock` / `conversation.composer.bar` are declared by a session-bound entry, so a dock chip is absent on the empty/hero screen; `sidebar.panellist`, `sidebar.footer.action`, `shell.overlay`, `settings.section` are root-scoped and always available.
8. **CORS/auth**: plugin routes are unauthenticated loopback HTTP with no CORS headers. Treat responses as public; require a custom header on mutating routes; never return a credential or a full URL containing one.
9. **`dsh.client.inject` misunderstanding**: it lists *packages* for module arrival, not services. Service readiness comes from `exports.inject` (`slots`, `locale`, `layout`, …). An entry whose injected service never appears stays pending and the page reports `<pkg>: pending (waiting for service: …)`.
10. **Requiring a client UI package** (`@deepseek-ai/dsh-client-ui-primitives`, or anything outside the seed table) throws at materialization; a throwing component abdicates its slot entry (`slot entry crashed in '<slot>'` in the console).
11. **Re-installing to iterate**: `already-installed`; reinstalling does not reload host JS. Edit + restart host, or rely on HMR for client code.
12. **Version skew**: profile-installed platform packages can be shadowed by the installation's copy; replacing a resolved package triggers a restart-required resolution. Don't add a dependency on a platform package you don't need, and don't pin one in the profile.
13. **`timeoutMs` on a tool is declarative only** — enforce your own deadline with `exec.signal`.
14. **`cordis.patch.yml` config replacement is wholesale.** A per-key override in the profile patch drops every key you did not restate.
15. **Secrets in `Config`** end up in `cordis.patch.yml` and in the rendered form. Store references only.

### End-to-end checklist (Web GUI)

1. **Author** `scnet-plan/{package.json,cordis.patch.yml,index.js,client.js,locale/en.json,locale/zh.json,icon.svg}`; keep `dsh.bundle.patch`, `dsh.client.platform:"web"`, `exports["./client"]`, and a unique row `id`.
2. **Syntax-check** before installing: `node --check index.js client.js` (client.js parses as a classic script; `window` is not evaluated).
3. **Install**: `plugin_manager install_bundle` with `target` = the absolute directory (Lead's action; approval needed). Read `application` / `warnings` / `pendingBuilds`.
4. **Confirm the host row without approval**: `cordis_inspect_query {platform:"host", provider:"Config", method:"listConfigs", input:{name:"dsh-scnet-plan"}}` → expect one entry with `patchId: "scnet-plan"`, `status: "schema"`, `packageDir` pointing at your checkout, and your `Config` JSON Schema.
5. **Confirm the tool**: `cordis_inspect_query {platform:"host", provider:"Tool", method:"listTools"}` contains `scnet_plan_snapshot`; call it once and check the rendered result.
6. **Confirm the route**: `curl -s http://127.0.0.1:57386/scnet-plan/snapshot` → HTTP 200 JSON (and `curl -i -X POST` without the header → 403/405). This is the fastest host-side proof.
7. **Page reload** (`http://127.0.0.1:57386`) and check the console for `loaded without registering`, `slot entry crashed`, `require(…) missed the module table`, or `pending (waiting for service…)`.
8. **Visual**: sidebar shows the SCNet icon; clicking it selects the main panel; the composer dock chip appears with a session open and opens the panel through `layout.selectPanel`; Settings → your section renders the card. Verify light **and** dark, and that no literal colors are used.
9. **Check the Client slot tree live** when a page is attached: `cordis_inspect_query {platform:"client", provider:"Slots", method:"listSubTree", input:{root:"main"}}` (and `sidebar.panellist`, `settings.section`, `conversation.composer.dock`). *In this session all client inspect queries time out — no page is connected to the client-inspect channel — so visual/registration confirmation must be done in a browser; report that limit rather than claiming success.*
10. **Unload test**: disable the plugin (Plugin Manager) → icon, panel, chip, settings card, tool, and route all disappear; re-enable → they return. This is the effect/disposal acceptance test.
11. **HMR test**: edit `client.js` (e.g. change a label) → the page updates within ~1s without a reload; React state inside the plugin is lost, which is expected.
12. **Failure path**: with no `SCNET_API_KEY` set, the route returns `{ok:false,code:"MISSING_KEY"}` and the panel shows a recovery hint naming `Settings`/`SCNET_API_KEY` — never a stack trace, and never the key.

---

## Appendix A — slot quick table (this build)

| Slot | Kind | Scope | Required options | Owner props | Exists while |
|---|---|---|---|---|---|
| `settings.section` | list | root | `id` | `{ close() }` | settings sidebar entry mounted |
| `settings.plugins.tab` | list | root | `id` | — | Plugins section mounted |
| `settings.general.item` | list | root | `id` | — (owner passes no props) | General section mounted |
| `main` | keyed | root | `key` | — | layout root mounted |
| `sidebar.panellist` | list | root | `id` | `{ size, active }` | sidebar mounted |
| `sidebar.footer.action` | list | root | `id` | — | sidebar mounted |
| `sidebar.workspaces` | single | root | — | workspace list seat | sidebar mounted |
| `shell.overlay` | list | root | `id` | — | layout root mounted |
| `shell.quota-notice` | chain | root | `select(owner)` | `{ code, message, dismiss, keepOpen }` | `shell.overlay` host mounted |
| `conversation.composer.dock` | list | session | `id` | — | composer bar mounted (session open) |
| `conversation.composer.bar` | single | session-maybe | — | — | conversation shell mounted |
| `conversation.chat.commandview` | keyed | session | `key` | folded command node | session |
| `conversation.input.left/right/overlay/dock/…` | list | session | `id` | varies | session |
| `sidebar.right.pane.tab` | keyed | session | `key` | — | right-bar pane tab |

Catalog source of truth: `dsh-cordis-client-runner/lib/client.js` from `//#region lib/types/client/slot-catalog.js`; it carries `summary`, `doc`, `registerOptions` (with per-option requirement/type/doc), `ownerProps` (TypeScript), `standardProps`, `declaredBy`, `occupants`, `replaceRisk`, and a runnable `example` per slot. The live `Slots.listSubTree` provider serves `SlotRegistry.snapshot(root)` plus exactly this catalog.

## Appendix B — client service quick table

| `ctx.<key>` | Use |
|---|---|
| `slots` | `inject(key, cb)`, `register(options, Comp)`, `entries(key)`, `entriesOfSlot(key)`, `getVersion(key)`, `subscribe`, `registerFactory` |
| `locale` | `register(ns, dicts)`, `bind(ns)`, `getLocale()`, `resolveText(text)`, `setLocale(id)` |
| `layout` | `selectPanel(id\|null)`, `beginNavigation()`, `toggleSidebar()`, `openRightbar()`, `closeRightbar()` |
| `theme` | `overrideTokens(source, {token:{light,dark}})`, `register(themeDefinition)`, `setTheme(id)`, `getTheme()` |
| `sessions` / `workspaces` / `uiWorkspace` | session and workspace state used by standard props |
| `remote` | generated Host Remotes (`ctx.remote.<ns>.<method>()`), `ctx.remote.$on(event, fn)` |
| `connection` | `fetch`, `rpc`, peer/browser plumbing (used by ai4scholar's credentials port) |
| `timer` | `timeout/interval/throttle/debounce` helpers |

Host services relevant to a Web plugin: `webServer`, `credentials`, `tools`, `commands`, `systemPrompt`, `settings`, `clientModules` (bundle graph/route), `configEditor`, `pluginPackages`. Query any of them live with
`cordis_inspect_query {platform:"host", provider:"Service", method:"listService", input:{service:"<key>"}}`.
