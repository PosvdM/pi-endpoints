# 技术文档

本文写给修改 pi-endpoints 代码的人。使用方法见 [README](../README.md)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口。加载时用配置和缓存注册服务商，再注册命令，不访问网络；记下会话的 `ctx`，供“每系最新”换掉模型和新版提醒时在界面上提示。 |
| `src/config.ts` | 配置、密钥、目录缓存、models.dev 和插件状态五个文件的路径和读写，配置、密钥、缓存和状态文件的类型；决定交给 pi 的 `apiKey` 写法。 |
| `src/catalog.ts` | 请求和解析服务端模型目录。 |
| `src/builtin.ts` | 在 pi 自带的模型目录里按名字查模型，判断模型原厂。 |
| `src/modelsdev.ts` | 下载 models.dev 目录、保存本地文件、映射成 pi 的参数，按名字查模型；判断本进程有没有 models.dev 数据。 |
| `src/resolve.ts` | 把目录、pi 自带目录、models.dev 和手动设置合并成 pi 的模型配置，记录每个值的来源；选择协议；生成 `thinkingLevelMap`；合并 compat。 |
| `src/betas.ts` | 决定 Anthropic 协议的模型要追加哪些 beta，并在请求体上追加。 |
| `src/defaults.ts` | 用 pi 的 `SettingsManager` 读写 pi 的默认模型，把默认模型和 Ctrl+P 列表里的旧模型换成新模型；这些读改写在进程内排队执行。 |
| `src/family.ts` | “每系最新”的纯函数：从模型 id 认出系列和版本，算出要启用的新版和要停用的旧版。 |
| `src/endpoints.ts` | `Endpoints` 类，持有全部状态，负责注册和注销服务商、刷新目录、执行“每系最新”和新版提醒、判断是否需要 models.dev、修改配置。 |
| `src/commands.ts` | `/endpoints` 命令：启动管理页并打开浏览器，有待处理的新版时在网址里带上服务名。`browserCommand()` 给出打开浏览器的命令，网址整个作为一个参数：Windows 上用 `rundll32 url.dll,FileProtocolHandler`，不经过 `cmd /c start`，否则 cmd 把网址里的 `&` 当成命令分隔符。插件只有这一个命令，所有操作都在管理页里完成。 |
| `src/version.ts` | 插件版本号，以及到 npm 检查有没有新版本。 |
| `src/web/server.ts` | 管理页的 HTTP 服务和接口，提供页面、页面脚本和第三方模块。 |
| `src/web/page.html` | 管理页的 HTML 外壳：token、样式表、import map 和入口脚本。 |
| `src/web/app/` | 管理页前端，Preact + htm 写的 ES 模块，没有构建步骤。各文件的分工见[前端结构](#前端结构)。 |

## 数据流

1. 插件加载时，`Endpoints` 读取 `endpoints.json`、`endpoints-auth.json`、`endpoints-cache.json` 和 `endpoints-modelsdev.json`，对每个服务调用 `register()`，不访问网络。配置或密钥文件读不了时，把原因记在 `loadError`，按空配置继续加载，命令照常注册。
2. `register()` 用 `resolveService()` 合并出所有模型，筛出已启用的对话模型，调用 `pi.registerProvider(name, ProviderConfig)`。服务没有密钥或没有可注册的模型时改为注销。
3. pi 调用服务商的 `refreshModels` 时（交互模式和 RPC 模式启动后、打开 `/model` 时），如果 `context.allowNetwork` 为真，就请求服务端目录、写缓存、执行[每系最新](#每系最新)（只改磁盘）和[新版提醒](#新版提醒)，然后按内存里的配置返回模型列表，由 pi 替换已注册的模型。目录请求结束后（成功或失败），在后台调用 `Endpoints.updateModelsDev()`，不等它完成；拿到新的 models.dev 数据后调用 `registerAll()`。`registerProvider` 会让 pi 以 `allowNetwork: false` 再调用一次 `refreshModels`，这时不刷新目录，也不会再触发 models.dev 更新，所以不会循环。
4. 管理页的 `refresh`（包括打开页面时的后台刷新）和新建服务时的首次刷新调用 `refreshForPage()`：先像修改操作一样调用 `beginChange()` 重新读取三个文件，目录请求结束后同样更新 models.dev，但等它完成，再执行每系最新，最后全量注册一次，然后返回状态。
5. 管理页和命令的修改都经过 `Endpoints` 的方法。每个方法先调用 `beginChange()` 重新读取配置、密钥和目录缓存三个文件，在最新内容上改动、保存，再调用 `registerAll()` 重新注册。

## 并发和过期数据

- 可能同时运行多个 pi，各自持有一份内存里的配置。修改前重新读文件，避免用一份旧内容整份覆盖另一个 pi 刚写入的修改。别的 pi 已注册的服务商不会自动更新，要运行 `/reload`。
- 配置或密钥文件损坏时，`beginChange()` 拒绝修改，免得用空配置覆盖用户待修的文件。
- `refresh()` 的请求完成后，先用 `isCurrent()` 确认服务还在、地址没变，再写缓存和错误记录。否则请求期间删除、改名或改地址的服务会被写回过期的目录。
- “每系最新”在目录请求之后修改配置，同样要防过期数据：`planFromFiles()` 在重新读取的文件快照上计算，并核对缓存里目录的来源地址（`Catalog.baseUrl`）和快照里的服务地址一致。没有变化时不写文件；配置或密钥文件损坏时不修改，内存状态不变，也不让刷新失败。目录缓存读取或解析失败时按没有缓存处理（缓存可以重建），显式刷新照常联网并重写缓存。pi 联网刷新时只保存快照里的配置，不把快照换进内存；管理页刷新是用户的显式操作，开始时就用 `beginChange()` 重新加载（配置或密钥文件读不了时拒绝并报错，内存不变），迁移时先保存成功，再把快照换进内存，最后全量注册，让所有服务的注册和内存一致。打开开关同样在快照上修改，保存成功后才换进内存。详见“每系最新”的[执行时机](#执行时机)。
- `refresh()` 自带 15 秒超时，并和调用方的 signal 合并。命令里的 `ctx.signal` 在 agent 空闲时为空，不能依赖它。

## 注册方式

使用 pi 旧式的 `pi.registerProvider(name, ProviderConfig)`。它允许每个模型单独设置 `api`、`baseUrl`、`headers`、`compat` 和 `thinkingLevelMap`，流式请求交给 pi 自带的协议实现。

这种写法下，`refreshModels` 返回的结果 pi 只放在内存里，不会存盘，所以插件自己维护 `endpoints-cache.json`，保证服务连不上时也能启动。

插件加载后再次调用 `registerProvider` 会立即生效，所以配置修改不需要重启 pi。

注册时还提供 `api: "anthropic-messages"` 和 `streamSimple`，接管这个服务上 Anthropic 协议模型的请求，用来追加 beta（见下一节）。pi 只在模型的 `api` 等于服务商的 `api` 时才调用服务商的 `streamSimple`，其他协议的模型仍走 pi 自带的实现。每个模型都写明了 `api`，服务商上的 `api` 不会被当作模型的默认协议。

## Anthropic beta

pi 的 Anthropic 实现按模型能力和请求内容生成 beta 列表（如 `mid-conversation-output-config-2026-07-01`），放在请求体的 `betas` 里，由 SDK 转成 `anthropic-beta` 请求头。模型的 `headers` 里只要有 `anthropic-beta`，pi 就用它整个替换这个列表，自己生成的 beta 全部丢掉。所以 Anthropic 协议的模型不把 `anthropic-beta` 交给 pi：

- `splitBetas()` 把服务和模型请求头里的 `anthropic-beta` 拆出来，按逗号分开，放进 `ResolvedModel.betas`；`ResolvedModel.headers` 不再含这个头。其他协议的模型请求头原样保留。
- 原厂是 Anthropic（`vendorOf()`）且上下文超过 `LONG_CONTEXT_THRESHOLD`（200000）时，`betas` 里加上 `context-1m-2025-08-07`。经 Anthropic 协议提供的其他模型（如 Kimi）不加，那边的服务未必认识这个 beta。CLIProxyAPI 只在调用方带了这个 beta 时才向 Claude 订阅账号申请 1M 上下文，而它的目录对这些模型报 1000000。不加的话，pi 按 1M 安排压缩，请求超过 200K 后被拒绝。
- `withBetas()` 包一层 `onPayload`，在 pi 组好的请求体上把 `betas` 追加进 `params.betas`，再交给调用方原有的 `onPayload`（pi 的 `before_provider_request` 事件就在那里）。
- 服务商的 `streamSimple` 按模型 id 从 `Endpoints.betas` 里取 beta，调用 `withBetas()` 后交给 pi-ai 的 `streamSimpleAnthropic`。`Endpoints.betas` 在注册和 `refreshModels` 返回模型时更新。

插件事件 `before_provider_request` 也能改请求体，但它拿不到模型信息，压缩和分支摘要的请求也不经过它，所以不用。

在 CLIProxyAPI 上验证过：Claude Sonnet 5.5 和 Claude Opus 5.5 带上 `context-1m-2025-08-07` 后，短消息正常返回。

## 文件格式

`endpoints.json`：

```json
{
	"services": [
		{
			"name": "cpa",
			"displayName": "CPA",
			"baseUrl": "https://example.com",
			"defaultApi": "openai-completions",
			"apiKeyEnv": "CPA_API_KEY",
			"headers": { "X-Title": "pi" },
			"enabled": ["gpt-6.1-sol"],
			"overrides": {
				"gpt-6.1-sol": { "contextWindow": 500000, "thinkingLevels": ["low", "high"] }
			}
		}
	]
}
```

- `baseUrl` 是服务根地址。保存时去掉末尾的 `/` 和 `/v1`。
- `overrides` 的字段见 `src/config.ts` 的 `ModelOverride`，保存前由 `validateOverride()` 校验。`thinkingLevels` 是 pi 的档位名列表，空数组表示不支持调节思考；列表里的 `off` 和 `none` 都表示可以关闭思考，转换时统一写成 `none`。也可以直接写 `thinkingLevelMap`，它优先于 `thinkingLevels`。
- `disabled: true` 表示停用整个服务，不注册到 pi，其余字段照常保存。服务启用时不写这个字段。编辑服务设置时沿用原值，只有 `setServiceDisabled()` 修改它。
- `latestPerFamily: true` 表示开启[每系最新](#每系最新)。没开启时不写这个字段。新建服务时按 `saveService` 收到的值保存（不传时关闭）；编辑服务设置时沿用原值，之后只有 `setLatestPerFamily()` 修改它。
- 服务配置由 `serviceProblem()` 校验：服务名、`http(s)` 地址、`defaultApi` 属于 `SUPPORTED_APIS`、`apiKeyEnv` 是合法的环境变量名、请求头的值都是字符串。手工写坏的服务不注册，原因显示在状态里。

`endpoints-auth.json` 的格式是 `{ "<服务名>": { "apiKey": "..." } }`。在 macOS 和 Linux 上写入时把权限设为 600。

`endpoints-cache.json` 的格式是 `{ "<服务名>": Catalog }`，`Catalog` 见 `src/catalog.ts`，其中 `baseUrl` 是读取这份目录时用的服务根地址，旧版本写的缓存没有这一项。文件读取或解析失败时当作没有缓存，顶层不是对象（如 JSON `null`）时同样当作没有缓存；各服务的目录本身结构不对时不在这个承诺内。

密钥、目录缓存和状态文件都是按服务名取值的对象，读取后由 `dict()` 复制成没有原型的对象（顶层不是对象时为空），插件内存里的这几份也是。`constructor` 是合法的服务名，在普通对象上会读到继承来的 `Object` 构造函数。新增按服务名取值的对象时，也要用 `dict()` 或 `Map`。

`endpoints-modelsdev.json` 的格式见 [models.dev](#modelsdev) 一节。

`endpoints-state.json` 是插件自己的运行状态，格式为 `{ "notifiedUpdates": { "<服务名>": [{ "from": "<旧 id>", "to": "<新 id>" }] } }`，记录[新版提醒](#新版提醒)已经提示过的替换。`loadState()` 读取时，文件读取或解析失败、结构不对时按空处理，只取自有属性，值不是数组的服务和不合规的记录丢掉；丢了记录只会多提示一次。

五个文件都先写临时文件再改名，避免写到一半时留下损坏的文件。文件位置取自 pi 的 `getAgentDir()`，测试通过环境变量 `PI_CODING_AGENT_DIR` 把它换成临时目录。

## 密钥

- 设置了 `apiKeyEnv` 且该环境变量有值时，交给 pi 的 `apiKey` 是 `${NAME}`，由 pi 在请求时读取环境变量。
- 否则用文件里的密钥。pi 会把 `apiKey` 里的 `$NAME` 当作环境变量、把开头的 `!` 当作命令，所以要先用 `escapeConfigValue()` 转义：`$` 写成 `$$`，开头的 `!` 写成 `$!`。
- 管理页的测试消息和目录请求直接使用原始密钥，不经过 pi 的转义规则。
- 请求头的值同样会被 pi 当作 `$NAME` 和 `!命令` 解释。`toPiModel()` 交给 pi 前用 `escapeConfigValue()` 转义，所以请求头一律按字面值发送，和目录请求、测试消息的行为一致。不转义的话，同步来的 `endpoints.json` 里以 `!` 开头的请求头会在每次请求时执行命令。

## 读取模型目录

`fetchCatalog()` 发两个请求：

1. `GET {root}/v1/models`。所有服务都支持，返回 `{ data: [...] }`，至少有 `id` 和 `owned_by`。Magpie 这类服务在每个模型上还带 `display_name`、`context_window`、`max_output_tokens`、`modalities.input`、`supported_reasoning_levels`、`native_endpoints`。
2. `GET {root}/v1/models?client_version=pi`。CLIProxyAPI 对它返回 Codex 格式 `{ models: [...] }`，带 `slug`、`context_window`、`max_tokens`、`input_modalities`、`supported_reasoning_levels`、`visibility`。按 `slug` 合并进第一步的结果，`Catalog.codex` 设为 `true`。其他服务会忽略这个参数或报错，这时只用第一步的结果。

第一步的结果必须保留，因为 Codex 格式里没有 `owned_by`，而选择协议要用它。

解析规则：

- 输入类型只保留 `text` 和 `image`，pi 不认识的（如 `pdf`）丢掉。
- `supported_reasoning_levels` 缺失时为 `undefined`（未知，交给下一层），为空数组时表示服务端明确不支持调节思考。
- `visibility: "hide"` 的模型标为隐藏，列表里默认不显示，但仍可启用。
- `resolveModel()` 另外把名字里有独立 `image` 一词的模型（如 `gpt-image-2`、`gemini-3.1-flash-image`）标为隐藏。它们是图片生成模型，pi 不能拿来对话，而 CLIProxyAPI 只把 `gpt-image-*` 标成了 `hide`。

## models.dev

pi 自带目录查不到的模型（如 new-api 类中转站上的国产模型），参数从 [models.dev](https://models.dev) 补齐。代码在 `src/modelsdev.ts`。

### 数据源

`MODELS_DEV_URL` 是 `https://models.dev/experimental/v2.0/api.json`，v2 完整目录，`base_model` 继承已经合并好。未压缩约 12 MB，gzip 后约 900 KB。服务端返回 `ETag`，请求带 `If-None-Match` 时，数据没有变化就回 304。models.dev 没有按服务商或按模型返回 JSON 的地址，只能取整份。v1 的 `/api.json` 默认去掉了分类模型，所以用 v2。

### 服务商名单

models.dev 上有 300 多个服务商，大多转卖别家的模型，参数和原厂不一定一致。`MODELS_DEV_PROVIDERS` 只列直营服务商，依次是 openai、anthropic、google、xai、deepseek、moonshotai、zai、zhipuai、alibaba、alibaba-cn、mistral、minimax、xiaomi、meta、cohere、perplexity、stepfun、volcengine、inception、ai21、typesafe。

`findModelsDev()` 先在原厂（`vendorOf()` 的结果，用同名的 models.dev 服务商）里找，再按名单顺序找其余服务商。每个服务商里按 `candidateIds()` 的顺序匹配 id，和 `findBuiltin()` 相同。

### 字段映射

`parseModelsDevModel()` 把一个模型映射成 pi 的参数，缺的字段留空，交给下一层：

| pi 参数 | 来源 |
| --- | --- |
| 名称 | `name`。和 pi 自带目录一样，只有去掉前缀后 id 完全相同时才借用（`sameModel()`） |
| 上下文 | `limit.context`，只取正数 |
| 最大输出 | `limit.output`，只取正数。不看 `limit.input` |
| 输入 | `modalities.input` 里有 `image` 或以 `image/` 开头的项时为 `["text", "image"]`，否则为 `["text"]` |
| 思考 | `capabilities.reasoning.supported` 为 `false` 时不支持调节。有 `effort` 列表时用 `levelsToMap(effort, api)` 转换，除 `off` 以外没有可选档位时 `reasoning` 为 `false`。`supported` 为 `true` 但没有 `effort` 时，`reasoning` 为 `true`，`thinkingLevelMap` 为 `undefined`，交给 pi 的默认档位。`toggle` 和 `budget` 不转换，pi 自己生成目录时也不用它们 |
| 价格 | `cost.text` 的 `input.price`、`output.price`、`input.cache.read`；`cacheWrite` 取 `input.cache.write`，是 TTL 表时取第一个值（默认 TTL），没有时取 `cache.explicit.write`，同样取第一个。`input` 或 `output` 缺失，或者 `unit` 不是 `token`（没写算 `token`）时不提供价格。不按上下文分档 |
| 模型类型 | `type`，没写时为 `chat` |

compat 不从 models.dev 取。

`type` 不是 `chat` 的模型（分类、图片生成、向量、语音等）pi 不能拿来对话：`resolveModel()` 把它们标为隐藏，`isChatModel()` 返回 `false`。`setEnabled()` 启用这类模型时报错；已经启用的保留在 `enabled` 里，但 `register()` 不注册它们，停用照常可以。插件不把它们注册成 pi 的分类模型或图片模型。

### 何时下载

- `Endpoints.needsModelsDev()` 判断是否需要：在没停用、有密钥的服务里，有模型（目录里的全部模型，加上已启用但目录里没有的）的上下文、最大输出、输入、思考或价格当前取自 models.dev 或默认值，或者有服务要靠 models.dev 判断模型类型：开启了[每系最新](#每系最新)的服务，以及 `mayHaveUpdates()` 为真的服务。`mayHaveUpdates()` 保守判断开关关着的服务拿到 models.dev 后有没有可能算出替换：服务没停用、配置没有问题、有已启用的模型，目录缓存的来源地址等于服务地址，并且 `mayReplace()` 为真。候选是目录里 `serverHidden()` 为假的模型，即只去掉服务端标为隐藏的和名字里带 `image` 的，不用 models.dev 已有的分类：用旧分类筛候选，分类更新后可能永远不再下载。`mayReplace()` 对每个有已启用成员的系列，只要候选里有比某个已启用成员新的成员，或者某个已启用成员已经不在目录里、而候选里有这个系列的成员，就返回真；它不套用 `pickLatest()` 的“整个系列不动”规则，因为排除非对话模型后最新版可能变（例如已启用 `m-1`、`m-2`、`m-4`，目录只剩 `m-2`、`m-3`，全部当候选时整个系列不动，`m-3` 是非对话模型时 `m-1` 会换成 `m-2`）。拿到 models.dev 后仍按完整规则计算。没有候选新版的服务不因为[新版提醒](#新版提醒)触发下载。不需要时不下载。
- `Endpoints.updateModelsDev()` 在需要时调用 `updateModelsDev()`，拿到新数据后调用 `registerAll()`。同一个 `Endpoints` 并发调用时共用同一个任务（`modelsDevTask`），只重新注册一次。管理页的刷新和开关通过 `waitModelsDev()` 等这个任务（传 `register` 为假），拿到一个认领函数。它们最后总会全量注册，到真正进入注册阶段时才调用认领函数，只做标记；中途因为文件读不了等原因退出时不认领。任务自己是否注册取决于有没有后台调用方：同一个任务若有后台 `updateModelsDev()` 调用方（`register` 为真），任务拿到新数据后先全量注册（它的回调先于等待方执行），显式入口随后还会再注册一次；纯管理页并行刷新多个服务时任务不注册，每次刷新各全量注册一次，没有这次额外注册。
- `updateModelsDev()` 先用 `loadModelsDev()` 重新读文件，因为可能同时运行着多个 pi，别的 pi 可能刚下载过；文件里的 `fetchedAt` 或 `etag` 变了就算数据变化。然后判断是否到期：本地没有数据，或上次成功检查超过 24 小时（`CHECK_INTERVAL_MS`）；失败后 30 分钟内（`RETRY_AFTER_MS`）不再试，失败时间只记在进程内。同一进程里同时只发一个请求，并发的调用共用结果。
- 请求带 `If-None-Match`，超时 60 秒（`FETCH_TIMEOUT_MS`）。回 304 时只更新 `checkedAt`。失败原因记在进程内，成功后清空；重新读到的文件的 `checkedAt` 晚于本进程的失败时间时，说明别的 pi 在失败之后检查成功过，也清空失败原因和 30 分钟的退避。`modelsDevStatus()` 把失败原因和时间、`fetching` 一起交给管理页。`updateModelsDev()` 不抛出错误。
- 调用时机见[数据流](#数据流)：pi 调用 `refreshModels` 时在后台进行；管理页刷新时等它完成。插件加载时只读文件，`pi -p` 这类非交互运行不会调用 `refreshModels`，所以只用本地文件。

### 文件格式

`endpoints-modelsdev.json`：

```json
{
	"version": 1,
	"etag": "\"abc\"",
	"fetchedAt": 1794880000000,
	"checkedAt": 1794880000000,
	"providers": {
		"moonshotai": {
			"kimi-k3": {
				"name": "Kimi K3",
				"limit": { "context": 1048576, "output": 1048576 },
				"modalities": { "input": ["text", "image/png"] },
				"capabilities": { "reasoning": { "supported": true, "effort": ["low", "high", "max"] } },
				"cost": { "text": { "input": { "price": 3, "cache": { "read": 0.3, "write": 3 } }, "output": { "price": 15 } } }
			}
		}
	}
}
```

- `fetchedAt` 是最后一次拿到新数据的时间，`checkedAt` 是最后一次成功检查的时间（含 304），都是毫秒时间戳。
- `providers` 只含名单上的服务商。每个模型保留 v2 目录的结构，只留下映射用得到的字段（`extractModelsDev()` 裁剪），文件约 190 KB。映射在读取时进行，修改映射规则不需要重新下载。
- 文件不缩进。以下情况整份文件当作没有数据，下次需要时重新下载，且不带 `If-None-Match`：JSON 损坏；`version` 不等于 `FILE_VERSION`；`fetchedAt` 或 `checkedAt` 不是有限的非负数；`etag` 不是字符串；某个服务商或模型不是对象；一个模型都没有。只丢掉坏的部分不行：留下的空数据会在到期后带着旧 ETag 请求，服务端回 304，数据就一直恢复不了。下载到的目录里一个名单上的模型都没有时，`extractModelsDev()` 报错，不写文件。要保存新的字段时把 `FILE_VERSION` 加一。

## 合并参数

`resolveModel()` 对每项参数按顺序取值：手动设置 → 服务端目录 → pi 自带目录 → models.dev → 默认值，并把来源记在 `Sourced.source` 里（models.dev 为 `"modelsdev"`），管理页据此显示来源标签。匹配到的 pi 自带条目和 models.dev 条目分别记在 `builtin` 和 `modelsDev`，models.dev 的模型类型记在 `modelType`。

### 在 pi 自带目录里查找

用 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModels()`。它是同步函数，插件加载时就能调用；`ctx.modelRegistry` 只在命令和事件里才有，赶不上启动时注册。代价是拿不到 pi 从 pi.dev 下载的较新目录。

`candidateIds()` 依次给出要查的 id：原样；去掉最后一个 `/` 之前的前缀；再反复去掉档位后缀（`-high` 等）、日期后缀（`-20250929` 等）和变体后缀（`-reversed`、`-thinking`、`-preview`、`-latest`）。

`findBuiltin()` 先在原厂服务商里找，再在其他服务商里找，但跳过 `RESELLERS` 列出的服务商：转卖别家模型的（openrouter、github-copilot 等）和订阅套餐（`qwen-token-plan*`、`kimi-coding` 等），它们的参数和原厂不一定一致。pi 新增这类服务商时要补进名单。

去掉前缀以外的后缀才匹配上时，不借用 pi 自带的显示名，否则 `claude-opus-5-5` 和 `claude-opus-5-5-high` 在 `/model` 里会显示成同一个名字。

### 原厂

`vendorOf()` 判断原厂是 `anthropic`、`openai`、`google` 还是 `xai`，原厂决定 compat 和价格从哪里抄。模型名里有 `claude`、`gemini`、`gemma`、`grok` 时以名字为准，因为 one-api 类中转站常把经 OpenAI 兼容渠道提供的 Claude 也标成 `owned_by: openai`；其余情况先看 `owned_by`，再看名字里的 `gpt`、`codex`、`o1` 这类写法。

协议选择（见下文）仍然先看 `owned_by`：这类中转站上的 Claude 可能确实只支持 OpenAI 协议，要靠管理页的测试消息确认。

### compat

compat 只从原厂在 pi 自带目录里的同名条目抄，不从服务端目录和 models.dev 取。`resolveCompat()` 依次合并：

1. 抄来的部分，规则见下面几条。
2. 最终协议为 `anthropic-messages` 时，设置 `sendSessionAffinityHeaders: true`（来源为默认值），即使抄来的字段为 `false`。其他协议不添加这个默认值。
3. 手动 `override.compat` 逐字段覆盖：值为 `null` 表示删掉这个字段，其他值覆盖。`false` 可以关闭会话亲和。

结果为空对象时为 `undefined`。合并时创建新对象，不修改手动配置或 pi 自带目录。手动 compat 写全了抄来的每个字段时，结果和直接使用手动 compat 相同；缺了某个抄来的字段时，这个字段保留抄来的值，要去掉它须把值写成 `null`。

- GPT 模型在 ChatGPT 订阅类服务上（`Catalog.codex` 为真，或 `owned_by` 为 `codex`）改抄 `openai-codex` 的条目。官方 `openai` 条目里的 `supportsStrictMode`、`supportsExplicitPromptCacheMode` 等是官方 API 的能力，订阅版没有。
- 只有原厂条目的协议和模型实际使用的协议属于同一族时才抄（`openai-codex-responses`、`azure-openai-responses` 和 `openai-responses` 算同一族）。例如手动把 Claude 改成走 `openai-completions` 后，Anthropic 的 compat 不再适用。
- 模型不支持调节思考时，从抄来的 compat 中去掉 `forceAdaptiveThinking` 和 `supportsMidConvoEffort`。带着这两个标志，pi 的 Anthropic 实现会忽略 `reasoning: false`，照样发送 adaptive thinking 和 `effort`。这条只作用于抄来的部分，手动写的照常生效。
- `compatSources` 记录最终 compat 里每个字段的来源（`manual`、`pi` 或 `default`），管理页据此显示每个字段的来源。`compat.source` 是整体来源：手动 compat 有任何字段（含值为 `null` 的）时为 `manual`，否则抄到了字段时为 `pi`，都没有时为 `default`。
- pi-ai 在请求选项有 `sessionId` 且会话亲和开启时发送 `x-session-affinity: <sessionId>`；`sessionAffinityFormat` 为 `openrouter` 时改用 `x-session-id`。会话 ID 和请求头由 pi 提供，插件不自行生成。
- 上下文、思考档位等参数不跟着 compat 抄，仍按上面的顺序取值。

在 CLIProxyAPI 上用真实请求验证过的组合：GPT-6 系列抄 `openai-codex` 的 compat 后，工具调用、文件编辑、对话中途换思考档位和换模型都正常；Claude Opus 5.5 抄 `anthropic` 的 compat 后，adaptive thinking 和工具调用正常。

### 价格

取值顺序是：手动设置 → 按原厂从 pi 自带目录抄的官方 API 价格 → models.dev → 0。服务端目录不提供价格。在 pi 自带目录里，GPT 一律找 `openai`，不找订阅版；原厂不明时（如 DeepSeek）不从 pi 自带目录抄价格。

### 思考档位

`levelsToMap()` 把服务端或 models.dev 列出的档位转成 pi 的 `thinkingLevelMap`：

- pi 的档位是 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。服务端列出的照原样映射，没列出的设为 `null`。
- `off` 只在服务端列出 `none` 或 `off` 时开放，值沿用服务端的写法。OpenAI 协议把这个值原样作为 `reasoning.effort` 发送，其他协议不看具体值。
- `ultra` 这类 pi 没有的档位丢弃。
- 按最终协议去掉 pi 发不出去的档位：`google-generative-ai` 去掉 `xhigh` 和 `max`（pi 的 Google 实现只接受 minimal 到 high，其他值直接报错）；`anthropic-messages` 去掉 `minimal`（pi 会把 `minimal` 原样作为 effort 发出）。
- 除 `off` 以外没有可选档位时，`reasoning` 设为 `false`。手动写的 `thinkingLevelMap` 也按这条规则判断，所以 `{ "off": null }` 表示"其余照常，只是不能关闭思考"。

`supportedLevels()` 复刻 pi 的 `getSupportedThinkingLevels()`，只有一处不同：`reasoning` 为 `false` 时 pi 返回 `["off"]`，它返回空数组，方便显示"不支持调节"。规则是：`null` 的档位不可选；`xhigh` 和 `max` 必须明确写出才可选；`off`、`minimal`、`low`、`medium`、`high` 没写时可选。所以 `off` 必须显式设为 `null`，否则 pi 会提供"关闭思考"，在 OpenAI 协议上发出 `reasoning.effort: "none"`，订阅类服务会以 400 拒绝。

## 选择协议

`selectApi()` 按顺序判断，前一步能判断就不看后面：

1. 手动设置。
2. `native_endpoints`：`/v1/responses` → `openai-responses`，`/v1/chat/completions` → `openai-completions`，`/v1/messages` → `anthropic-messages`。
3. `owned_by`：`openai`、`codex`、`xai`、`grok` → `openai-responses`；`anthropic`、`claude` → `anthropic-messages`；`gemini`、`google` → `google-generative-ai`。`antigravity`、`vertex-ai`、`custom` 这类值看不出协议，跳过。CLIProxyAPI 上 `owned_by: antigravity` 的模型既有 Gemini 也有 Claude。
4. 模型名：含 `claude` → `anthropic-messages`，含 `gpt` → `openai-responses`，含 `gemini` → `google-generative-ai`。
5. 服务的 `defaultApi`，没有设置时为 `openai-completions`。

`baseUrlFor()` 按协议拼接地址：`anthropic-messages` 用根地址，`google-generative-ai` 用 `{root}/v1beta`，其余用 `{root}/v1`。

## 每系最新

服务开启 `latestPerFamily` 后，已启用模型所在的每个系列只保留目录里的最新版。服务端把 `gpt-6.1-sol` 换成 `gpt-6.2-sol` 后，用户不用手动换。

### 识别系列

`familyOf()` 把模型 id 拆成系列名、版本和日期：

- 最后一个 `/` 之前的前缀留在系列名里，`codex/` 和 `claude/` 是不同的系列。系列名区分大小写。
- 名字按 `-` 拆分。4 位及以上的纯数字段（`DATE_SEGMENT`，如 `20250929`、`0324`、`2024`）是日期，紧跟在日期段后面的 1 到 2 位数字段也算日期（`2024-08-06`），这种拆开写的日期由 `normalizeDate()` 归一成紧凑的 `20240806`，和 `20231201` 这种写法能直接比较。日期不进系列名，也不算版本。
- 剩下的段里，第一串连续的版本段是版本：`6.2` 是 `["6", "2"]`，`5-5` 也是 `["5", "5"]`。版本段匹配 `VERSION_SEGMENT`：不超过 3 位的数字，或者含 `.` 的数字，可以以 `v` 开头。第一串之后再出现的数字段留在系列名里，如 `gemini-2.5-flash-preview-05-20` 的系列名是 `gemini-flash-preview-05-20`。
- 其余的段用 `-` 连起来，加上前缀，就是系列名。系列名不记录版本段原来的位置，`gpt-6-sol` 和 `gpt-sol-7` 是同一系列。没有版本段、或者只有版本段的名字不属于任何系列。

例如 `codex/gpt-6.2-sol` → `codex/gpt-sol` 6.2；`opencode-zen-free/mimo-v2.6-flash-free` → `opencode-zen-free/mimo-flash-free` 2.6；`claude-sonnet-4-5-20250929` → `claude-sonnet` 4.5，日期 20250929；`deepseek-v3-0324` 和 `deepseek-v3-1120` → `deepseek` 3，日期分别是 0324 和 1120；`Index-Translate-35B-A3B` 不属于任何系列。

`compareMembers()` 按段比较版本，缺的段按 0 算；版本相同且两边都有日期时再按段比较日期。只有一边有日期时算作相同：不带日期的名字通常是指向最新版的别名。数字以十进制字符串保存和比较（去掉开头的 0 后先比长度，再逐位比），很长的数字不会溢出。

### 规则

`pickLatest(enabled, candidates, catalog)` 是纯函数。`catalog` 是目录里的全部 id；`candidates` 是其中可以被选为新版的模型，由 `planLatest()` 去掉隐藏模型（`ResolvedModel.hidden`）和 models.dev 标为非对话的模型（`isChatModel()`）。对至少有一个已启用成员的每个系列：

1. 候选里没有这个系列的成员时不动。
2. 取候选里版本最高的成员；其中带日期的只留日期最新的，不带日期的都留下。这些是最新版。
3. 被取代的已启用成员：比最新版旧的，以及和最新版同版本、但已经不在 `catalog` 里的（如别名 `claude-sonnet-4-5` 消失，只剩 `claude-sonnet-4-5-20250929`）。没有被取代的成员时不动，所以目录里还在的同版本多个 id 都保留。
4. 已启用的成员里有最新版时，被取代的成员都换成它；否则，已启用的成员里还有既不是最新版、又不被取代的（比最新版还新，或者同版本但在目录里被隐藏）时整个系列不动，免得降级；都被取代时启用最新版里的一个：有带日期的选它（第 2 步只留了日期最新的），否则选不带日期的，几个都不带日期时选在目录中排在前面的。
5. 新版放在第一个被停用的旧版原来的位置。

不属于任何系列的已启用模型不动。返回的 `replacements` 列出每个被停用的旧版和替换它的新版，为空表示没有变化。旧 id 的 `overrides` 留在配置里，不复制给新 id。

`planLatest(service, catalog, force)` 只在开关开着或 `force` 为真（[新版提醒](#新版提醒)和 `applyLatestOnce()`）时计算。调用 `pickLatest()` 前检查两项，不满足时跳过：

- 目录缓存的来源地址（`latestCatalog()`，同时要求服务配置没有问题）：`fetchCatalog()` 把请求用的根地址记在 `Catalog.baseUrl`。旧版本写的缓存没有这一项，按来源未知处理；和服务的地址不同时，缓存可能是另一个 pi 在服务改地址前写下的旧目录。
- models.dev 数据：`hasModelsDevData()` 为假（本进程既没读到有效的本地文件，也没下载成功过）时推迟，否则分不出候选是不是对话模型。开启开关的服务、目录里有候选新版的服务让 `needsModelsDev()` 为真（见[何时下载](#何时下载)），所以插件会按原有的退避（失败后 30 分钟）去下载。有数据、但 models.dev 里查不到的模型按对话模型处理，和注册一致。数据旧了不推迟，见[已知限制](#已知限制)。

### 执行时机

`planFromFiles()` 用 `readFiles()` 读三个文件的快照，在快照上调用 `planLatest()`，有变化时返回改过启用列表的快照。没有变化时不写文件，也不替换内存里的状态，pi 的联网刷新不会变成一次隐式的重新加载。配置或密钥文件读不了时只记下 `loadError`，内存里的配置、密钥和缓存保持原样。

三个显式入口立即生效，开关和换过的启用列表都只保存一次，最后全量注册一次：

- `setLatestPerFamily(name, on)` 和 `applyLatestOnce(name)` 都经过 `applyLatest()`：先用 `readSnapshot()` 校验磁盘快照（读不了或没有这个服务时报错）。打开开关和只换一次时等 models.dev 更新完（`waitModelsDev(true)`，最多 60 秒；开关还没保存或不改开关，所以不检查 `needsModelsDev()`）。然后重新读一次最新快照，在快照上写开关（只换一次时不写）、调用 `planLatest()`；`saveConfig()` 成功后才用 `commit()` 把快照换进内存，认领 models.dev 的注册，调用一次 `registerAll()`。保存失败时内存不变，也不注册。
- `applyLatestOnce(name)` 按开关开着时的规则只换一次，不改开关，返回换掉的模型。没有可换的（包括 models.dev 拿不到数据）时返回空数组，不写文件；models.dev 刚更新、还没人为它注册过时照样全量注册一次。
- `refreshForPage()`：管理页的 `refresh`（包括打开页面时的后台刷新）和新建服务的首次刷新。先 `beginChange()` 重新读取配置、密钥和缓存，配置或密钥文件读不了时抛错，内存不变，不请求目录；pi 联网刷新已经写进磁盘的迁移因此在这里显示出来并在本进程生效。然后刷新目录，等 models.dev 更新完，目录刷新成功时调用 `migrateAndCommit()`：先 `saveConfig()`，成功后才用 `commit()` 把快照换进内存。只要载入了快照，不管目录刷新成功与否、有没有迁移，最后都认领 models.dev 的注册并调用一次 `registerAll()`（放在 `finally` 里）。`beginChange()` 换进内存的可能还有别的 pi 改过的其他服务（地址、密钥、请求头），它们的 `refreshModels` 会按内存里的新配置发布模型，只注册目标服务的话，pi 里这些服务还是旧注册，旧密钥会配上新地址，新模型也查不到请求头。

pi 的 `refreshModels`（`allowNetwork` 为真）目录刷新成功后调用 `migrateOnDisk()`，**只改磁盘**：保存快照里的配置，替换 pi 设置里的旧模型，再提示用户；不改本进程的内存状态，`refreshModels` 照常按内存里的配置返回模型列表，也不重新注册。原因：

- pi 1.3 重新注册服务商时会取消这个服务商正在进行的刷新，并让所有服务商做一次 `allowNetwork: false` 的刷新，同一批里还没返回的服务就跳过了这轮联网刷新。
- pi 1.3 发布 `refreshModels` 的结果时会清空 `Model.headers`，请求时按初次注册的模型查请求头，在这里返回新模型会丢掉它的请求头。
- 把整份快照换进内存，会连带换入别的 pi 写入的密钥和地址。

新配置在新会话（pi 设置已改）、新子代理、`/reload` 或下次启动时生效；本进程之后任何经过 `beginChange()` 的修改也会读到它。保存失败时放弃，不影响刷新。models.dev 这时通常还在后台更新，本进程没有数据时推迟到下次刷新。

换了模型之后，`afterMigration()` 用 `replaceModels()` 替换 pi 设置里的旧模型，再调用 `Endpoints.notify` 提示。只改磁盘时提示“<服务名>：旧 id → 新 id 已写入配置，新会话生效，当前 pi 用 /reload”；显式入口提示“<服务名>：旧 id → 新 id。当前会话请用 /model 切换”，旧 id 从注册里去掉后，正在用它的会话不会自动切换。这两种提示和[新版提醒](#新版提醒)一样用 `warning` 级别：pi 的 `info` 提示会被紧接着的下一条 `info` 覆盖。`notify(message, level)` 由 `src/index.ts` 设置：它在 `session_start` 时记下 `ctx`，`session_shutdown` 时清掉；有界面（`ctx.hasUI`）时调用 `ctx.ui.notify()` 并返回真，否则返回假。子代理和 `-p`、json 模式没有界面，提示会被丢掉，调用方据此判断提示有没有显示。

### 新版提醒

开关关着的服务出了已启用模型的新版时，在 pi 里提示用户，免得用户不知道这个功能。

- `updates(name)`：如果现在打开开关会发生的替换，即 `planLatest(service, catalog, true)` 的 `replacements`，用内存里的配置和缓存计算，不修改任何东西。开关开着、服务停用或配置有问题、models.dev 没有数据、目录缓存的来源地址和服务地址不符时为空。管理页状态里每个服务的 `updates` 就是它。
- `noticeUpdates(name)`：pi 的 `refreshModels`（`allowNetwork` 为真）目录刷新成功、`migrateOnDisk()` 之后调用。它和 `migrateOnDisk()` 一样遵守上一节的约束：在 `readFiles()` 重新读取的快照上计算，不改内存、不重新注册、不等待任何东西。本进程没有 models.dev 数据时直接返回，推迟到下次联网刷新。开关开着的服务由 `migrateOnDisk()` 处理，这里跳过；快照里拿不到密钥（`resolveKey(service, files.auth)` 为空，例如别的 pi 删了密钥）的服务也跳过，管理页的 `updates` 不看密钥。
- 每个“服务 + 旧 id → 新 id”只提示一次，已提示的记在 `endpoints-state.json` 的 `notifiedUpdates` 里。同一服务这次新出现的替换拼成一条提示：“<显示名> 有新版模型：旧 id → 新 id、……。输入 /endpoints，在模型页点“换成新版”只换这一次，或点“开启自动替换”以后自动换。”没有显示名时用服务名。级别是 `warning`。提示里的按钮名和管理页模型页横幅上的按钮（`src/web/app/models.js`）一致，改按钮名时要同步改这句提示和 README。
- 只有 `notify` 返回真（提示确实显示了）时才记录；没有界面（`ctx.hasUI` 为假）时不记录，留到下次有界面的联网刷新。RPC 模式和 SDK 宿主的界面不在这条判断内，见[已知限制](#已知限制)。写之前重新读状态文件，只改这个服务的记录，同时去掉已经不在待处理列表里的记录（用户换了模型，或出了更新的版本）；记录没有变化时不写文件。写失败时忽略。

管理页的状态带上 `updates`，`applyLatestOnce` 接口按同样的规则只换一次；`/endpoints` 的网址带上第一个有新版的服务名，页面直接打开这个服务的“模型”页。接口、网址和界面见[管理页](#管理页)。

### pi 设置

`replaceModels(provider, replacements)` 用 [pi 默认模型](#pi-默认模型)一节的 `SettingsManager` 方式读写全局设置：

- `defaultProvider` 等于这个服务、`defaultModel` 是被停用的旧 id 时，改成新 id。
- `enabledModels` 是数组时，精确等于 `<服务名>/<旧 id>` 的项换成 `<服务名>/<新 id>`；新的已经在列表里时只删掉旧的。通配符和大小写不同的项不改，不是数组时不动。
- 没有变化时不写文件。`settings.json` 读不了或写不了时，`afterMigration()` 跳过这一步，启用列表的修改已经保存。
- `SettingsManager` 打开时读一次文件、保存时写回改过的字段。两次修改同时进行时，后保存的会用自己读到的旧 `enabledModels` 覆盖前一次的修改，所以 `replaceModels()`、`writeDefaultModel()` 和 `clearDefaultModel()` 在 `serialized()` 的进程内队列里一个接一个执行。同一批刷新里两个服务同时迁移，两个旧项都会换掉。

### 已知限制

- 多个 pi 同时修改配置或 pi 设置时，读、改、写之间没有跨进程锁，后写的可能覆盖先写的。所有修改路径都是这样。`endpoints-state.json` 同样不加锁，多个 pi 同时联网刷新时，同一个新版可能各提示一次。
- RPC 模式下 `ctx.hasUI` 为真，`ctx.ui.notify()` 只是向客户端发一个事件，客户端可能丢弃，新版提醒仍会记成已提示。`ctx.mode` 区分不了这种情况：pi-web-ui 这类用 SDK 自己实现界面的宿主也以 `mode: "rpc"` 绑定扩展，它的 `notify` 会弹出提示，必须按已显示记录；pi-web-ui 给后台会话用的无界面上下文同样是 `rpc` 模式、`hasUI` 为真，提示会被丢掉。所以插件只看 `hasUI`，客户端丢掉的提醒不会再发，用户仍可在管理页看到“有新版”。
- 后台的 models.dev 更新拿到新数据后调用 `registerAll()`，同样可能取消 pi 正在进行的其他服务商的刷新。
- 本地的 models.dev 数据旧了、下载又一直失败时不推迟，新出现的模型可能还没有分类，按对话模型处理，可能被选为新版。
- pi 联网刷新不等 models.dev，后台更新还在进行时，迁移按本地已有的旧数据判断模型类型。
- 管理页刷新开始时已经把新快照换进内存，而 pi 里还是旧注册，要等刷新结束（包括等 models.dev，最多 60 秒）才全量注册。这期间如果 `/model` 触发了联网刷新，`refreshModels` 会在旧注册下发布按新配置算出的模型；刷新结束的全量注册后恢复一致。
- 原有问题，不是本功能引入的：当前会话正在用的模型被移出注册（停用，或被“每系最新”替换）后，pi 1.3 重新注册时会保留会话里的旧模型对象（含旧地址），而密钥按服务名取最新的注册。如果服务的地址和密钥同时被改过（通常是另一个 pi 改的），之后任何一次全量注册（管理页的任意修改操作、管理页刷新）后，这个会话的下一条请求可能把新密钥发到旧地址。main 上所有经过 `beginChange()` + `registerAll()` 的管理操作都是这样。规避办法：改了服务地址或密钥后，各个 pi 用 `/reload`，或在 `/model` 里重新选模型。

### 注册出错

`register()` 和 `unregister()` 调用 pi 时经过 `sync()`：出错时把原因记在 `syncErrors`，不抛出，下次注册成功时清掉。`registered` 和 beta 记录只在注册或注销成功后更新；注销出错时保留记录，下次 `registerAll()` 会再试。配置已经保存，显式入口照常返回已保存的状态，pi 设置的替换和提示照常执行；后台 models.dev 更新后的 `registerAll()` 也不会产生未处理的 Promise 拒绝。状态里的 `syncError` 带上原因，管理页提示用户 `/reload`。

## 注册时的约束

- 服务名必须匹配 `^[a-z0-9][a-z0-9._-]*$`，且不能和 pi 自带的服务商同名。用 `registerProvider` 注册同名服务商并提供 `models` 时，会替换掉它全部的自带模型。
- 停用的服务不注册。
- 没有密钥时不注册。pi 本身允许注册，但会让用户去 `/login` 输入密钥，和本插件的密钥管理冲突。
- 已启用但目录里没有的模型仍然注册，用 pi 自带目录、models.dev 和默认值补齐参数。读过目录后，这类模型在管理页里标为"目录里没有"；还没读过目录时不标。
- models.dev 标为非 `chat` 类型的模型即使已启用也不注册。服务只启用了这类模型时，按没有启用的模型处理，不注册。`setEnabled()` 启用一个模型前总是解析它的类型，目录里没有的 id 按 `{ id }` 解析，所以目录外的非对话模型同样不能启用。

## pi 默认模型

管理页的星标读写的是 pi 自己的设置：`~/.pi/agent/settings.json` 里的 `defaultProvider` 和 `defaultModel`。`src/defaults.ts` 用 pi 导出的 `SettingsManager` 写入，效果和在 pi 的 `/model` 里按 Ctrl+S 相同：

- `SettingsManager` 写文件时加锁，只合并改动的字段，不会覆盖其他 pi 进程或 pi-sync 同时写入的设置。
- 设置了 `enabledModels`（Ctrl+P 轮换列表）时，pi 会把新的默认模型加进去，这里也照做。pi 先按展开后的模型判断是否已在列表里，这里只比对完整的模型名，列表里的通配符已经覆盖这个模型时会多加一条。`enabledModels` 不是数组时不改它，照样写入默认模型；数组里不是字符串的项不参与比对。
- `settings.json` 读不了时，`SettingsManager` 不写文件，只把错误记下来，`open()` 先检查加载错误并拒绝写入。
- 用 `projectTrusted: false` 打开，不读当前目录的 `.pi/settings.json`。写入只写全局设置，读取也只读全局设置，页面上的星标才和刚写入的值一致；项目设置的 `enabledModels` 也不会被合并进全局列表。项目设置里的 `defaultModel` 在那个目录里仍然优先，页面不显示它。

只有已启用、并且服务已注册到 pi 的模型才能设为默认，否则 pi 启动时找不到它，会改用别的模型。取消默认时，页面带上它认为的当前默认模型；`clearDefaultModel()` 在设置队列里先核对，当前默认模型已经不是它（例如被“每系最新”或别的 pi 换掉了）时不写文件，接口返回最新状态并带 `defaultChanged: true`，页面提示没有取消。一致时调用 `setDefaultModelAndProvider(undefined, undefined)`，写入时这两个字段从 JSON 里去掉，`enabledModels` 不动。pi 没有默认模型时，新会话用 Ctrl+P 列表的第一个，没有列表时用 pi 自带的各服务默认模型或第一个可用模型。运行中的 pi 在内存里保留旧的设置，运行 `/reload` 后才读到新的默认模型。

## 管理页

`startWebUI()` 在 `127.0.0.1` 的随机端口启动 HTTP 服务。`/endpoints` 保存的是启动用的 Promise，连按两次也只启动一个服务器。打开的网址是 `http://127.0.0.1:<端口>/?token=<token>`；有服务的 `updates` 不为空时，`pageUrl()` 在后面加上 `&service=<服务名>`，取第一个这样的服务。`session_shutdown`（退出、`/reload`、`/new`、`/resume`、`/fork`）时关闭。防护措施：

- 每次启动生成 24 字节的随机 token。页面地址带 `?token=`，页面把 token 写进 `<meta>`，之后的接口请求放在 `x-endpoints-token` 请求头里。先比较字节长度，再用 `timingSafeEqual` 比较内容。
- `Host` 请求头必须是 `127.0.0.1:<端口>`，防止 DNS 重绑定。
- 修改操作只接受 `POST` 和 `application/json`。跨站页面发这种请求必须先通过 CORS 预检，而服务不响应预检。
- 页面带 `Content-Security-Policy`（`pagePolicy()`）：脚本和样式只能来自本机服务（`'self'`），内联脚本只放行 import map，按它内容的 SHA-256 放行，哈希在每次请求时按 `page.html` 计算；不允许 `'unsafe-inline'`。页面因此不能写内联的 `<style>` 和 `style` 属性，样式都写在 `style.css` 的类里。
- `/app/<文件名>`（`src/web/app/` 这一层里文件名符合 `APP_FILE` 的 `.js`、`.css`）和 `/vendor/<文件名>`（`VENDOR` 里列出的第三方模块）不含密钥，不要求 token，但同样检查 `Host`。其他路径一律返回 404。
- 接口不返回密钥，只返回密钥来源（`file` 或 `env`）。

接口：

- 每个 JSON 响应带 `X-Endpoints-Seq` 响应头，是 `sendJson()` 按发出顺序递增的编号。状态和编号在同一段同步代码里生成：操作自己带回状态时（如刷新的 `refreshError`、`clearDefaultModel` 的 `defaultChanged`、`applyLatestOnce` 的 `replaced`），`handle()` 在发出前重新生成一次状态，保留操作附带的字段，因为从操作生成状态到 `sendJson()` 之间隔着 `await`，别的请求可能已经改了数据。页面只采用编号比已采用的大的状态，错误响应的编号不用来更新状态。
- `GET /api/state` 返回全部状态，包括 `loadError`、插件版本 `version` 和 models.dev 的状态 `modelsDev: { fetchedAt?, checkedAt?, error?, fetching }`（见 `modelsDevStatus()`）。每个模型在 `ResolvedModel` 的字段（含 `compatSources`、`modelsDev`、`modelType`）之外，还有 `enabled`、`levels` 和原样的手动设置 `override`，手动 compat 里值为 `null` 的字段也在其中。
- `GET /api/update` 在 npm 上有新版本时返回 `{ latestVersion, releaseUrl }`，否则返回 `{}`。
- `POST /api/<操作>` 执行 `saveService`、`removeService`、`setKey`、`setServiceDisabled`、`setLatestPerFamily`、`applyLatestOnce`、`setEnabled`、`setOverride`、`setDefaultModel`、`clearDefaultModel`，成功时返回最新状态，失败时返回 400 和 `{ error }`。状态里每个服务带 `latestPerFamily` 布尔值，以及 `updates: Array<{ from, to }>`：开关关着时，现在打开开关会做的替换，只用于提示，由 `updates()` 计算，为空的情况见[新版提醒](#新版提醒)。
- `setLatestPerFamily` 的请求体是 `{ name, latestPerFamily }`。打开时先按缓存的目录执行一次[每系最新](#每系最新)，再返回状态。
- `applyLatestOnce` 的请求体是 `{ name }`，按“每系最新”的规则把这个服务已启用的旧版换成新版一次，不改开关，和打开开关一样替换 pi 设置并在 pi 里提示（见[执行时机](#执行时机)），返回状态和 `replaced: Array<{ from, to }>`（没有可换的时为空数组）。
- `clearDefaultModel` 的请求体是 `{ name, id }`，即页面显示的默认模型；和当前的不一致时不清除，返回 200、最新状态和 `defaultChanged: true`。
- 每个服务的 `status` 里可能有 `syncError`：配置已保存，但向运行中的 pi 注册或注销时出错，页面在服务顶部显示原因并提示 `/reload`。
- `setEnabled` 启用 models.dev 标为非 `chat` 类型的模型时返回 400，错误信息说明模型类型，如"jev-latest 是分类模型，pi 不能拿它对话"；停用不受限制。`setDefaultModel` 对这类模型同样返回 400。
- `refresh` 先重新读取配置、密钥和缓存（配置或密钥文件读不了时返回 400；缓存读取或解析失败时按没有缓存处理），再刷新服务目录，需要时再更新 models.dev，等它完成（最多 60 秒）后返回 200 和最新状态。目录刷新失败时状态里多一个 `refreshError`；models.dev 失败不算刷新失败，原因只在 `modelsDev.error` 里。
- `testModel` 的请求体可以带 `thinkingLevel`：pi 的档位名，必须是这个模型 `levels` 里 `off` 以外的一项，否则返回 400。返回 `{ test: { ok, stopReason, text, error, durationMs, request } }`，`request` 含 `api`、`baseUrl`、`id`，带了档位时还有 `thinkingLevel`。
- `saveService` 带 `previousName` 表示修改已有服务（可以改名），不带表示新建，新建时重名会报错。可以带 `apiKey`，和服务一起保存。`service.latestPerFamily` 只在新建时写进配置，修改已有服务时忽略，开关用 `setLatestPerFamily` 修改。新建服务时只要拿得到密钥（`apiKey` 或密钥环境变量），就接着按 `refresh` 的方式刷新目录和 models.dev；刷新失败时服务已经保存，和 `refresh` 一样返回 200 和带 `refreshError` 的状态。

图例旁的 models.dev 状态由 `modelsDevStatus()` 按 `state.modelsDev` 生成：`fetching` 为真时显示正在拉取，有 `error` 时用警告颜色显示原因，否则显示 `fetchedAt`；都没有时不显示。页面只在拿到新状态时重画，而 `refresh` 等 models.dev 拉取完成才返回，所以刷新目录时一般看不到“正在拉取”；只有页面拿到的状态正处于拉取中时才显示，例如打开页面时 pi 正在后台拉取。

`src/version.ts` 从包内的 `package.json` 读出 `VERSION`。`checkUpdate()` 读取 `https://registry.npmjs.org/pi-endpoints/latest`，用 `isNewer()` 按数字逐段比较 `x.y.z`，带预发布后缀的版本不比较。成功的结果在进程内缓存 6 小时；失败（超时 10 秒）时沿用上次的结果，30 分钟后再试。查询可能要等几秒，所以页面先用 `/api/state` 渲染，再由 `store.checkUpdate()` 单独请求 `/api/update`，有新版时在版本号右边加上指向 GitHub Release 的绿色箭头。

`testModel` 用 `@earendil-works/pi-ai/compat` 的 `completeSimple()` 按当前解析出的参数发一条消息，Anthropic 协议的模型同样经过 `withBetas()`，超时 60 秒。请求带 `thinkingLevel` 时，把它作为 `completeSimple()` 选项里的 `reasoning` 发送，由 pi 按模型的 `thinkingLevelMap` 转换；不带时不设置思考档位。失败时返回 pi 给出的 `errorMessage`，其中包含服务端的原始错误。

### 前端结构

页面没有构建步骤。`page.html` 只有外壳：服务端把 token 写进 `<meta name="endpoints-token">`，import map 把 `preact`、`preact/hooks`、`htm` 指向 `/vendor/` 下的文件，入口是 `/app/main.js`。`src/web/app/` 下的文件都是 ES 模块，带 `// @ts-check`，类型写在 JSDoc 里，`npm run check` 一起检查（`tsconfig.json` 开启了 `allowJs` 和 `checkJs`）：

| 文件 | 内容 |
|---|---|
| `main.js` | 入口，读出 token，调用 `startApp()`。 |
| `app.js` | 根组件 `App`：当前服务、标签页、打开的模型、筛选条件、折叠的分组和冻结的显示；服务页头、提示条和标签页。`startApp(root, { token, search, fetch })` 创建 store 并渲染，测试也从这里启动。 |
| `store.js` | `createStore()`：服务端状态、顶部错误、正在刷新的服务、提交中的开关和提示条，以及所有接口请求。 |
| `nav.js` | 左栏：服务列表、“有新版”角标、“添加服务”按钮和版本号。 |
| `models.js` | “模型”页：新版横幅、工具栏、前缀按钮、“每个系列只保留最新版”开关、模型表和图例。 |
| `drawer.js` | 模型详情面板。 |
| `settings.js` | 密钥卡片、服务表单（添加和修改共用）和删除服务。 |
| `ui.js` | 共用的小组件：来源圆点、星标、启用开关、图标，以及绑定到 Preact 的 `html` 模板函数。 |
| `util.js` | 不碰 DOM 的纯函数和常量：版本号、前缀、数字解析、手动设置表单和 override 的互转等。 |
| `style.css` | 全部样式，深色和浅色主题跟随系统。 |

组件只读 store 的快照（`store.get()`），修改都经过 store 的方法；store 每次变化后通知 `App` 重画。Preact 按虚拟 DOM 对比更新，输入框、焦点和滚动位置在重画后保留。表单里没保存的内容放在各自组件的状态里，后台刷新带来的新状态不会冲掉它们。服务表单和密钥卡片以服务名加 `formEpoch` 为 key，切换服务或点“添加服务”时 `formEpoch` 加一，表单重新开始。

### 请求和状态

- `store.act()` 执行修改操作。操作排成一个队列，前一个结束后才发下一个，页面上的操作按点击顺序生效。成功时采用返回的状态、清掉顶部错误、按需显示提示条；返回 `refreshError` 时把原因显示在顶部；失败时把原因显示在顶部，返回 `undefined`。
- 开关（模型启用、服务停用、“每个系列只保留最新版”）调用 `act()` 时带上 `pending`：请求期间开关按要切换到的值显示，结束后按服务端状态显示，失败时也就拨回原样。
- `store.refresh()` 刷新目录。刷新最长要等一分钟（等 models.dev），不进队列。`refreshing` 记下正在刷新的服务，这些服务的“刷新目录”按钮显示“刷新中…”且不能点。打开页面后，以及在左栏重新启用服务后，在后台刷新（`background`），失败原因只显示在服务状态里，不弹顶部提示。
- 后台刷新和修改操作并发时，响应可能先发后到。`accept()` 按 `X-Endpoints-Seq` 丢掉编号不大于已采用编号的状态，所以刷新期间完成的修改不会被刷新带回的旧状态覆盖，而刷新最后生成的状态照常采用。按请求的发送顺序编号做不到这一点：刷新先发，但它的状态最后生成。
- 测试消息（`store.test()`）不改状态，也不进队列。

### 冻结的显示

停用或修改模型、停用服务之后，行先留在原处，方便改回来。页面对模型表和左栏用同一条规则：本次打开期间冻结。

- 模型表：`visibleModels()` 以“服务 + 筛选条件 + 点前缀按钮的次数”为范围，范围不变时，显示过的模型一直留着，新符合条件的模型照常加进来。所以“已启用”页里停用的模型、没勾“显示隐藏模型”时停用的隐藏模型、按协议筛选时改了协议的模型都留在原处，“每系最新”自动启用的新版会补进“已启用”页。换服务、改搜索或筛选条件、点任意前缀按钮（包括再点一次当前的）或刷新页面后，按条件重新选。冻结的记录 `frozen` 放在 `App` 里，切到“服务设置”再回来时保留。
- 左栏：`serviceGroups()` 按 `parked` 把服务分成启用和停用两组，组内保持配置文件里的顺序。`parked` 记下服务第一次出现时是否停用，只在刷新页面时重来；删除服务时删掉它的记录。打开页面时默认选中两组合起来的第一个服务。

模型分组和排序的规则在 `util.js` 里：`prefixOf()` 取模型 id 的前缀（去掉 `/` 之前的部分，取第一段，去掉末尾的数字，转小写），分组和前缀按钮按 `byPrefix()` 排序：`PREFIX_ORDER` 里的前缀按列表顺序排在前面，其余按字母序；`newestFirst()` 按 `versionOf()` 从模型名里取出的版本号从大到小排。版本号最多三位数字，可以带一个字母后缀（`4o`）；参数规模（`120b`）和日期（`2024-08-06`、`20250929`）不算版本号。分组的折叠状态按“服务名/前缀”记录。前缀按钮上的数量按前缀以外的筛选条件计算（含冻结的模型）；当前选中的前缀数量为 0 时仍然显示这个按钮，筛选条件始终看得到。

### 详情面板

`App` 以“服务名/模型 id”为 key 渲染 `Drawer`，换模型时整个面板重建：表单、错误和测试结果都只属于这一个模型。测试消息返回时面板已经关了或换了模型，结果就丢掉。

- 生效的参数、启用开关和星标每次重画都按最新状态显示，后台刷新或“每系最新”换掉模型时会跟着变。面板里的模型被停用、又已经不在目录里时，它不再出现在状态里：`App` 传入最后一次看到的模型（`fallback`），开关按未启用显示，星标清空，因为旧的星标可能还显示着被换掉的默认模型，点了会清掉刚换上的新默认模型。
- 手动设置表单打开时由 `overrideToForm()` 填好，保存或清除成功后按服务端保存的值重填。`dirty` 比较表单当前的值和打开（或上次保存）时的值，测试消息的档位不算在内。Esc、遮罩和 × 都经过 `requestClose()`，有修改时先用 `confirm()` 确认。焦点在文字输入框或下拉框里，或者 `event.isComposing` 为真、`keyCode` 为 229（输入法正在选字）时，Esc 不处理。
- 错误的位置：面板分为可滚动的 `.drawer-body`、提示区 `.drawer-msg` 和底部按钮。提示区在底部按钮上方，不随面板内容滚动，显示表单的校验错误和打开面板之后出现的顶部错误（面板盖住了页面顶部；先后用 `store.errorMark()` 判断），没有错误时显示测试结果。操作成功清掉顶部错误后，测试结果重新显示。
- 数字解析：上下文和最大输出用 `type="text"`，由 `parseCount()` 解析。Safari 和 Firefox 的 number 输入框遇到 `1,000,000`、`1M` 时 `value` 为空字符串，会被当成没填。`parseCount()` 接受纯数字、每三位用逗号或空格分组的数字，以及带 K（1000）或 M（1000000）后缀、不超过对应位数的小数；按字符串移动小数点，避免 `1.1 * 1e6` 这类浮点误差。结果不是正的安全整数时报错，不保存。K 和 M 的含义和 `short()` 显示的单位一致。
- 思考档位：空数组回显为 `none`，再次保存时不会丢失；只填 `none` 时保存为空数组。价格只填部分字段时，其余字段补 0。
- 对话以外的模型：`nonChat()` 按 `modelType` 判断，没有这个字段时按对话模型处理。这类模型没启用时，`EnableSwitch` 生成的开关带 `aria-disabled`，在 `click` 里 `preventDefault()` 阻止勾选；星标也按不能用处理。点不了的开关和星标都不用 `disabled`：禁用的控件会吞掉点击，列表行就打不开详情了。列表行的点击处理只跳过没有 `aria-disabled` 的控件。
- compat 标签的来源取自 `compatSources`；没有这个字段时按整体来源推算，Anthropic 协议的会话亲和字段没有手动设置时算作默认值。`override.compat` 里值为 `null` 的字段显示为带删除线的标签。
- 测试消息的档位下拉框列出 `levels` 里除 `off` 以外的档位，选了档位时请求体带 `thinkingLevel`，结果按 `test.request.thinkingLevel` 显示实际发出的档位。

### 其他约定

- 星标用 SVG 画，字符 ★ 在部分系统上显示成彩色 emoji，颜色不受 CSS 控制。取消默认模型时请求体带上这颗星代表的模型，服务端返回 `defaultChanged` 时提示“pi 默认模型已经换了”。
- 模型 id 过长时只截断 id 本身，星标和标签留在行内可见。
- 密钥框用 `type="password"` 加 `autocomplete="one-time-code"`，免得 Chrome 把网站的已存密码填进来：密码框会忽略 `off`，`new-password` 会弹出生成密码。密钥框只出现在添加服务的表单里，已有服务的密钥在单独的密钥卡片里修改。
- 添加服务时，`slugify()` 按显示名生成名字，用户手动改过名字后停止跟随，把名字清空后重新跟随；名字在失焦时去掉首尾空格并转为小写。添加表单里的“每个系列只保留最新版”默认勾选，提交时作为 `service.latestPerFamily` 发送；修改已有服务时不带这个字段。提交期间按钮显示“添加中…”或“保存中…”且不能点。
- “每个系列只保留最新版”开关在“模型”页的前缀按钮一行里，紧挨“已启用”，旁边写明“已开启”或“未开启”，悬停时显示规则。服务的 `updates` 不为空时，左栏服务名旁显示“有新版”；开关关着时，“模型”页顶部显示横幅，列出替换，“换成新版”调用 `applyLatestOnce` 并提示换了哪些，“开启自动替换”调用 `setLatestPerFamily`。
- 网址带 `service` 参数且服务存在时，打开页面后选中这个服务的“模型”页；否则选中第一个服务。
- 刷新失败时，顶部已经显示“刷新失败：原因”，服务页头下方同样原因的错误条不再重复显示，关掉顶部提示后再显示。

修改管理页时按 [`test/web-ui-checklist.md`](../test/web-ui-checklist.md) 逐条核对，那里列出了界面必须保留的行为和覆盖它们的测试。

## 依赖和导入

- `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 由 pi 提供，放在 `peerDependencies: "*"`。`devDependencies` 里的同名包只用于类型检查和测试。
- 管理页用的 `preact` 和 `htm` 放在 `dependencies`，pi 安装 npm 或 git 插件时会一起安装。插件代码不导入它们，只由 `server.ts` 的 `VENDOR` 用 `createRequire()` 找到文件，原样提供给浏览器：`preact` 和 `preact/hooks` 按包的导出解析到 ESM 文件；`htm` 的 `require` 条件指向 UMD 文件，浏览器不能当模块导入，所以取同目录下的 `htm.module.js`。preact 11 只发布 ESM。`preact/hooks` 的文件里写的是裸模块名 `preact`，由页面的 import map 解析。升级这两个包后，确认这些文件路径仍然存在。
- `happy-dom` 只用于前端的 DOM 测试。
- pi 加载插件时把这些包名映射到宿主自己的副本。映射只覆盖包根和 `@earendil-works/pi-ai` 的 `compat`、`providers/all`、`oauth` 子路径，导入其他子路径会绕过映射。
- 插件里的 `fetch` 在 pi 里会走 pi 配置的 HTTP 代理（pi 启动时替换全局 `fetch`）。单独用 Node 运行代码时，需要自己设置代理。
- 只使用可以直接擦除的 TypeScript 语法（`tsconfig.json` 开启了 `erasableSyntaxOnly`），不用参数属性和 `enum`，这样代码也能被 Node 的类型擦除直接运行。

## 测试

`npm test` 运行 `test/` 下的单元测试：

- `catalog.test.ts`：目录解析、合并和请求顺序，用 `vi.stubGlobal("fetch")` 模拟服务端。
- `modelsdev.test.ts`：models.dev 的字段映射、裁剪、服务商名单和匹配顺序；下载时机，包括 24 小时检查间隔、失败后 30 分钟、304、超时、同时只发一个请求、重新读取别的 pi 写入的文件和损坏的文件。用 `vi.stubGlobal("fetch")` 模拟 models.dev，用 `Date.now` 的替身控制时间。
- `resolve.test.ts`：参数分层（含 models.dev 层）、思考档位、协议选择、compat 的逐字段合并和 `null`、价格和 Anthropic beta 规则，用 `setBuiltinCatalogForTest()` 换掉 pi 自带目录，用 `setModelsDevForTest()` 换掉 models.dev 数据。整份写在配置里的手动 compat 合并后结果不变，也有测试覆盖。
- `endpoints.test.ts`：注册条件、停用服务、密钥和请求头的转义、环境变量、缓存、改名和删除、输入校验（含 compat 字段值为 `null`）、models.dev 的启动读取、是否需要下载、`refreshModels` 后台下载后重新注册且不循环、非对话模型不注册也不能启用、刷新期间的并发修改、多个 pi 进程、损坏的配置文件；以及经过服务商 `streamSimple`、由模拟 `fetch` 捕获的请求中，Anthropic 会话亲和头遵守默认值、手动开关和会话 ID 条件，`anthropic-beta` 同时含有 pi 生成的 beta 和插件追加的 beta。
- `family.test.ts`：系列和版本的识别（前缀、`v` 开头、4 位及以上的日期段、拆开写的日期归一、无系列的名字、大小写、版本段的位置）、版本比较（含很长的数字），`mayReplace()` 的保守判断（含同系有更新的已启用成员、已启用成员离开目录的情况），以及 `pickLatest()` 的规则：目录里没有的旧 id、系列在目录里没有成员、不降级、没有变化、别名消失时由同版本的 id 接替、目录里还在的同版本 id 都保留、带日期和不带日期的候选共存时选哪个（包括旧 id 从目录消失的情况）、拆开写的日期不会让新版被当成旧版。
- `latest.test.ts`：“每系最新”的开关和执行时机。用一个模仿 pi 1.3 模型运行时的替身（重新注册会取消进行中的刷新，并让所有服务商做一次离线刷新）检查 `refreshModels` 里的迁移只改磁盘（配置和 pi 设置已改、内存和返回给 pi 的列表不变、不注册、发了提示）、同一批里快的服务迁移不影响慢的服务、两个服务同时迁移时 `enabledModels` 里两个旧项都换掉；还包括打开开关和管理页刷新只全量注册一次、管理页并行刷新时共享的 models.dev 下载不另外触发全量注册、管理页刷新（目录失败时也一样）后其他服务的地址、密钥和请求头按新配置注册、打开开关时保存失败内存不变、开关中途失败时后台 models.dev 更新照常注册、注册出错时记下原因并照常返回、注销出错时保留记录并在下次重试、刷新失败不执行、没有变化时不写文件、pi 联网刷新不替换内存状态、联网刷新写盘后管理页刷新读到新启用列表并只注册一次、管理页刷新时文件读不了就拒绝、隐藏和非对话模型不算新版、从没拿到过 models.dev 数据时推迟（包括只因开关才需要 models.dev 的服务）、缓存没有来源地址或来源地址不符时跳过、配置或密钥文件损坏时内存状态不变；以及 pi 默认模型和 `enabledModels` 的替换、`settings.json` 损坏时跳过。新版提醒部分覆盖：只在开关关着且有新版时用 `warning` 提示、显示名和多个替换拼成一条、同一替换只提示一次（包括另一个实例读同一份记录）、出了更新的版本再提示并去掉旧记录、没有界面时不记录、记录文件损坏按空处理、目录刷新失败时不提示、models.dev 没有数据时推迟；目录里有候选新版才需要 models.dev（服务端隐藏的模型、停用的服务、来源地址不符都不算；models.dev 已有的非对话分类和“整个系列不动”不影响判断）；磁盘上的密钥被删时不提醒；服务名为 `constructor` 时照常提示和记录，状态里也不会把继承的属性当成目录；`updates()` 的各种空情况；`applyLatestOnce()` 返回换掉的模型、不改开关、替换 pi 设置并提示，没有可换的时不写文件、不注册。
- `web.test.ts`：管理页的 token、Host 和 JSON 检查，CSP 只放行 import map 的哈希，页面脚本、样式和第三方模块的提供方式（不要 token、检查 Host、htm 是 ES 模块、其他路径 404），响应编号递增，各项操作（含“每系最新”的开关和刷新后的替换、状态里的 `updates`、`applyLatestOnce`、新建服务时保存 `latestPerFamily` 而编辑时忽略），刷新时等待 models.dev 及其失败不算刷新失败，测试消息的思考档位校验和发送，写入 pi 默认模型时保留其他设置、取消默认时核对页面带的默认模型、拒绝写入损坏的 `settings.json`，以及版本比较和更新检查的缓存与失败处理。
- `web-ui.test.ts`：管理页前端的 DOM 测试，在 happy-dom 里用 `startApp()` 启动页面，假的 `fetch` 按接口约定返回状态和 `X-Endpoints-Seq`。覆盖左栏的分组、默认选中的服务、`service` 网址参数和“有新版”角标；后台刷新时表单、密钥框和焦点保留，详情面板的生效参数跟着刷新；修改操作排队，先发后到的旧状态被丢弃、长时间刷新带回的新状态被采用，测试消息的结果只显示在发出时的模型上；冻结的显示；新版横幅的两个按钮、工具栏开关的位置和失败时拨回；添加服务时“每个系列只保留最新版”默认勾选并随请求发送；详情面板的 `aria-disabled` 星标、Esc 和未保存修改的确认、数字解析和错误位置、取消默认模型时的核对；以及 `parseCount()`、`versionOf()`、`prefixOf()`。界面上需要保留的其他行为列在 `test/web-ui-checklist.md`。
- `index.test.ts`：插件入口的 `notify` 在没有界面时返回假、提示不记录，有界面时用 `warning` 提示并记录，会话结束后不再用旧的界面；`/endpoints` 网址在有待处理的新版时带上第一个这样的服务名；打开浏览器的命令把带 `&` 的网址整个作为一个参数，Windows 上不经过 cmd。

`test/helpers.ts` 提供临时的 pi 配置目录和只记录注册调用的假 `ExtensionAPI`。models.dev 的数据和下载状态（失败时间、错误原因）是模块级的，同一个测试文件里的用例共用，所以会用到它的测试文件在 `beforeEach` 里调用 `setModelsDevForTest(undefined)` 清空。

真实服务的验证在 pi 里进行，例如：

```bash
pi -e . --list-models
pi -e . --no-session -p --model cpa/gpt-6.1-sol:high "Reply with exactly: OK"
```

非交互模式不执行扩展命令，`/endpoints` 需要在交互界面或 RPC 模式（`pi --mode rpc`）里测试。管理页的接口可以绕开命令，直接用 `startWebUI()` 启动后请求。

## 发布流程

npm 包由 GitHub Actions 通过 npm 的 Trusted Publishing（OIDC）发布，不使用 npm 令牌：

1. 用 `npm version <版本> --no-git-tag-version` 改 `package.json` 和 `package-lock.json` 里的版本号，提交并推送到 main。
2. 在这个提交上创建 GitHub Release，标签写成 `v<版本>`，如 `v0.2.1`。
3. Release 发布后触发 `.github/workflows/publish.yml`：运行类型检查和单元测试，确认标签和 `package.json` 的版本一致，然后 `npm publish`。npm 根据 `package.json` 里的版本号发布，不看标签，所以两者不一致时工作流直接失败。

npm 上 pi-endpoints 的 Trusted Publisher 配置为 GitHub Actions、`PosvdM/pi-endpoints`、工作流文件 `publish.yml`、不指定环境、允许 `npm publish`。改工作流文件名后要在 npm 上删掉旧配置并重建。仓库和包都是公开的，所以 npm 会自动为每次发布生成 provenance。

Trusted Publishing 需要 npm 11.5.1 或更高版本和 GitHub 托管的运行器，工作流里会先把 npm 升到 11 的最新版。
