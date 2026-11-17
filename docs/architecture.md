# 技术文档

本文写给修改 pi-endpoints 代码的人。使用方法见 [README](../README.md)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口。加载时用配置和缓存注册服务商，再注册命令，不访问网络。 |
| `src/config.ts` | 配置、密钥、目录缓存和 models.dev 四个文件的路径和读写，前三个文件的类型；决定交给 pi 的 `apiKey` 写法。 |
| `src/catalog.ts` | 请求和解析服务端模型目录。 |
| `src/builtin.ts` | 在 pi 自带的模型目录里按名字查模型，判断模型原厂。 |
| `src/modelsdev.ts` | 下载 models.dev 目录、保存本地文件、映射成 pi 的参数，按名字查模型；判断是否到了下载时间。 |
| `src/resolve.ts` | 把目录、pi 自带目录、models.dev 和手动设置合并成 pi 的模型配置，记录每个值的来源；选择协议；生成 `thinkingLevelMap`；合并 compat。 |
| `src/betas.ts` | 决定 Anthropic 协议的模型要追加哪些 beta，并在请求体上追加。 |
| `src/defaults.ts` | 用 pi 的 `SettingsManager` 读写 pi 的默认模型。 |
| `src/endpoints.ts` | `Endpoints` 类，持有全部状态，负责注册和注销服务商、刷新目录、判断是否需要 models.dev、修改配置。 |
| `src/commands.ts` | `/endpoints` 命令：启动管理页并打开浏览器。插件只有这一个命令，所有操作都在管理页里完成。 |
| `src/version.ts` | 插件版本号，以及到 npm 检查有没有新版本。 |
| `src/web/server.ts` | 管理页的 HTTP 服务和接口。 |
| `src/web/page.html` | 管理页前端，单个 HTML 文件，原生 JS，没有构建步骤。 |

## 数据流

1. 插件加载时，`Endpoints` 读取 `endpoints.json`、`endpoints-auth.json`、`endpoints-cache.json` 和 `endpoints-modelsdev.json`，对每个服务调用 `register()`，不访问网络。配置或密钥文件读不了时，把原因记在 `loadError`，按空配置继续加载，命令照常注册。
2. `register()` 用 `resolveService()` 合并出所有模型，筛出已启用的对话模型，调用 `pi.registerProvider(name, ProviderConfig)`。服务没有密钥或没有可注册的模型时改为注销。
3. pi 调用服务商的 `refreshModels` 时（交互模式和 RPC 模式启动后、打开 `/model` 时），如果 `context.allowNetwork` 为真，就请求服务端目录、写缓存，然后返回最新的模型列表，由 pi 替换已注册的模型。目录请求结束后（成功或失败），在后台调用 `Endpoints.updateModelsDev()`，不等它完成；拿到新的 models.dev 数据后调用 `registerAll()`。`registerProvider` 会让 pi 以 `allowNetwork: false` 再调用一次 `refreshModels`，这时不刷新目录，也不会再触发 models.dev 更新，所以不会循环。
4. 管理页的 `refresh` 和新建服务时的首次刷新，在目录请求结束后同样调用 `updateModelsDev()`，但等它完成再返回状态。
5. 管理页和命令的修改都经过 `Endpoints` 的方法。每个方法先调用 `beginChange()` 重新读取配置、密钥和目录缓存三个文件，在最新内容上改动、保存，再调用 `registerAll()` 重新注册。

## 并发和过期数据

- 可能同时运行多个 pi，各自持有一份内存里的配置。修改前重新读文件，避免用一份旧内容整份覆盖另一个 pi 刚写入的修改。别的 pi 已注册的服务商不会自动更新，要运行 `/reload`。
- 配置或密钥文件损坏时，`beginChange()` 拒绝修改，免得用空配置覆盖用户待修的文件。
- `refresh()` 的请求完成后，先用 `isCurrent()` 确认服务还在、地址没变，再写缓存和错误记录。否则请求期间删除、改名或改地址的服务会被写回过期的目录。
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
- 服务配置由 `serviceProblem()` 校验：服务名、`http(s)` 地址、`defaultApi` 属于 `SUPPORTED_APIS`、`apiKeyEnv` 是合法的环境变量名、请求头的值都是字符串。手工写坏的服务不注册，原因显示在状态里。

`endpoints-auth.json` 的格式是 `{ "<服务名>": { "apiKey": "..." } }`。在 macOS 和 Linux 上写入时把权限设为 600。

`endpoints-cache.json` 的格式是 `{ "<服务名>": Catalog }`，`Catalog` 见 `src/catalog.ts`。文件损坏时当作没有缓存。

`endpoints-modelsdev.json` 的格式见 [models.dev](#modelsdev) 一节。

四个文件都先写临时文件再改名，避免写到一半时留下损坏的文件。文件位置取自 pi 的 `getAgentDir()`，测试通过环境变量 `PI_CODING_AGENT_DIR` 把它换成临时目录。

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

- `Endpoints.needsModelsDev()` 判断是否需要：在没停用、有密钥的服务里，有模型（目录里的全部模型，加上已启用但目录里没有的）的上下文、最大输出、输入、思考或价格当前取自 models.dev 或默认值。不需要时不下载。
- `Endpoints.updateModelsDev()` 在需要时调用 `updateModelsDev()`，拿到新数据后调用 `registerAll()`。同一个 `Endpoints` 并发调用时共用同一个任务，只重新注册一次。
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

只有已启用、并且服务已注册到 pi 的模型才能设为默认，否则 pi 启动时找不到它，会改用别的模型。取消默认时调用 `setDefaultModelAndProvider(undefined, undefined)`，写入时这两个字段从 JSON 里去掉，`enabledModels` 不动。pi 没有默认模型时，新会话用 Ctrl+P 列表的第一个，没有列表时用 pi 自带的各服务默认模型或第一个可用模型。运行中的 pi 在内存里保留旧的设置，运行 `/reload` 后才读到新的默认模型。

## 管理页

`startWebUI()` 在 `127.0.0.1` 的随机端口启动 HTTP 服务。`/endpoints` 保存的是启动用的 Promise，连按两次也只启动一个服务器。`session_shutdown`（退出、`/reload`、`/new`、`/resume`、`/fork`）时关闭。防护措施：

- 每次启动生成 24 字节的随机 token。页面地址带 `?token=`，页面把 token 写进 `<meta>`，之后的接口请求放在 `x-endpoints-token` 请求头里。先比较字节长度，再用 `timingSafeEqual` 比较内容。
- `Host` 请求头必须是 `127.0.0.1:<端口>`，防止 DNS 重绑定。
- 修改操作只接受 `POST` 和 `application/json`。跨站页面发这种请求必须先通过 CORS 预检，而服务不响应预检。
- 页面带 `Content-Security-Policy`，只允许内联脚本和样式，以及对本机接口的请求。
- 接口不返回密钥，只返回密钥来源（`file` 或 `env`）。

接口：

- `GET /api/state` 返回全部状态，包括 `loadError`、插件版本 `version` 和 models.dev 的状态 `modelsDev: { fetchedAt?, checkedAt?, error?, fetching }`（见 `modelsDevStatus()`）。每个模型在 `ResolvedModel` 的字段（含 `compatSources`、`modelsDev`、`modelType`）之外，还有 `enabled`、`levels` 和原样的手动设置 `override`，手动 compat 里值为 `null` 的字段也在其中。
- `GET /api/update` 在 npm 上有新版本时返回 `{ latestVersion, releaseUrl }`，否则返回 `{}`。
- `POST /api/<操作>` 执行 `saveService`、`removeService`、`setKey`、`setServiceDisabled`、`setEnabled`、`setOverride`、`setDefaultModel`、`clearDefaultModel`，成功时返回最新状态，失败时返回 400 和 `{ error }`。
- `setEnabled` 启用 models.dev 标为非 `chat` 类型的模型时返回 400，错误信息说明模型类型，如"jev-latest 是分类模型，pi 不能拿它对话"；停用不受限制。`setDefaultModel` 对这类模型同样返回 400。
- `refresh` 刷新服务目录，需要时再更新 models.dev，等它完成（最多 60 秒）后返回 200 和最新状态。目录刷新失败时状态里多一个 `refreshError`；models.dev 失败不算刷新失败，原因只在 `modelsDev.error` 里。
- `testModel` 的请求体可以带 `thinkingLevel`：pi 的档位名，必须是这个模型 `levels` 里 `off` 以外的一项，否则返回 400。返回 `{ test: { ok, stopReason, text, error, durationMs, request } }`，`request` 含 `api`、`baseUrl`、`id`，带了档位时还有 `thinkingLevel`。
- `saveService` 带 `previousName` 表示修改已有服务（可以改名），不带表示新建，新建时重名会报错。可以带 `apiKey`，和服务一起保存。新建服务时只要拿得到密钥（`apiKey` 或密钥环境变量），就接着按 `refresh` 的方式刷新目录和 models.dev；刷新失败时服务已经保存，和 `refresh` 一样返回 200 和带 `refreshError` 的状态。

页面的状态变化后，`render()` 重建整个内容区，包括操作失败时显示错误。服务表单因此把还没保存的内容记在 `serviceDraft` 里，按服务名区分，重建时优先用它；保存成功、切换服务或点"添加服务"时清掉。密钥卡片的输入框同样把没保存的密钥记在 `keyDraft` 里，清掉的时机相同。新增其他会被 `render()` 重建的表单时，也要这样保存输入。打开页面后，以及在左栏重新启用服务后，`refreshInBackground()` 在后台调用 `refresh`，失败原因只显示在服务状态里，不弹顶部提示。这是唯一不由用户操作触发的重画，所以由 `flush()` 把它推迟到没有文字输入框获得焦点（`typing()` 为假）、也没有按着鼠标的时候，免得输入框失去焦点，或者点击落在被替换掉的元素上。`refreshing` 记下正在刷新的服务，这些服务的"刷新目录"按钮显示"刷新中…"并且不能点，手动刷新也用它。密钥框只出现在添加服务的表单里，已有服务的密钥在单独的密钥卡片里修改。密钥框用 `type="password"` 加 `autocomplete="one-time-code"`，免得 Chrome 把网站的已存密码填进来：密码框会忽略 `off`，`new-password` 会弹出生成密码。添加服务时，`slugify()` 按显示名生成名字，用户手动改过名字后停止跟随，把名字清空后重新跟随。

模型列表的分组和排序只在前端做，规则在 `page.html` 里：`prefixOf()` 取模型 id 的前缀（去掉 `/` 之前的部分，取第一段，去掉末尾的数字，转小写），分组和前缀按钮按 `byPrefix()` 排序：`PREFIX_ORDER` 里的前缀按列表顺序排在前面，其余按字母序；`newestFirst()` 按 `versionOf()` 从模型名里取出的版本号从大到小排。版本号最多三位数字，可以带一个字母后缀（`4o`）；参数规模（`120b`）和日期（`2024-08-06`、`20250929`）不算版本号。"已启用"页列的是点按钮时已启用的模型（`pinned`），停用的模型留到下次点按钮或刷新页面，免得开关一点模型就从眼前消失。左栏的服务也这样处理：`parked` 记下页面打开时每个服务是否停用，`serviceGroups()` 按这份记录把服务分成启用和停用两组，组内保持配置文件里的顺序；打开页面后新加的服务按加入时的状态归组。

列表的 `kept` 出于同样的原因，记下当前服务里刚用开关启用或停用、或在详情里保存或清除了手动设置的模型，`matches()` 不按"显示隐藏模型"和协议筛选排除这些模型；改了筛选条件（搜索、协议、`owned_by`、"显示隐藏模型"和前缀按钮）、切换服务或刷新页面时清空。`renderChips()` 在当前选中的前缀数量为 0 时补上这个按钮，筛选条件始终看得到。

详情面板不随 `render()` 重建，免得冲掉没保存的输入；`renderDrawer()` 只在打开面板、保存或清除手动设置后重建，开关的状态和星标由各自的代码单独更新。

- 关闭前的确认：`overrideForm()` 建好表单后记下各输入框的值，`drawerDirty()` 和当前的值比较，测试消息的档位不算在内。Esc、遮罩和 × 都调用 `closeDrawer()`，有修改时先用 `confirm()` 确认。`typing()` 为真，或者 `event.isComposing` 为真、`keyCode` 为 229（输入法正在选字）时，Esc 不处理。
- 错误的位置：面板分为可滚动的 `.drawer-body`、提示区 `#drawer-msg` 和底部按钮。表单的校验错误、`run()` 失败的原因和测试结果都由 `drawerMessage()` 放进提示区，它在底部按钮上方，不随面板内容滚动。`run()` 成功时只清掉提示区里的错误，测试结果保留。
- 数字解析：上下文和最大输出用 `type="text"`，由 `parseCount()` 解析。Safari 和 Firefox 的 number 输入框遇到 `1,000,000`、`1M` 时 `value` 为空字符串，会被当成没填。`parseCount()` 接受纯数字、每三位用逗号或空格分组的数字，以及带 K（1000）或 M（1000000）后缀、不超过对应位数的小数；按字符串移动小数点，避免 `1.1 * 1e6` 这类浮点误差。结果不是正的安全整数时报错，不保存。K 和 M 的含义和 `short()` 显示的单位一致。
- 对话以外的模型：`nonChat()` 按 `modelType` 判断，没有这个字段时按对话模型处理。这类模型没启用时，`enableSwitch()` 生成的开关带 `aria-disabled`，在 `click` 里 `preventDefault()` 阻止勾选；星标也按不能用处理。点不了的开关和星标都不用 `disabled`：禁用的控件会吞掉点击，列表行就打不开详情了，列表行的点击处理只跳过没有 `aria-disabled` 的控件。
- compat 标签的来源取自 `compatSources`；没有这个字段时按整体来源推算，Anthropic 协议的会话亲和字段没有手动设置时算作默认值。`override.compat` 里值为 `null` 的字段显示为带删除线的标签。
- 测试消息的档位下拉框列出 `levels` 里除 `off` 以外的档位，选了档位时请求体带 `thinkingLevel`，结果按 `test.request.thinkingLevel` 显示实际发出的档位。

图例旁的 models.dev 状态由 `modelsDevStatus()` 按 `state.modelsDev` 生成：`fetching` 为真时显示正在拉取，有 `error` 时用警告颜色显示原因，否则显示 `fetchedAt`；都没有时不显示。页面只在拿到新状态时重画，而 `refresh` 等 models.dev 拉取完成才返回，所以刷新目录时一般看不到“正在拉取”；只有页面拿到的状态正处于拉取中时才显示，例如打开页面时 pi 正在后台拉取。

`src/version.ts` 从包内的 `package.json` 读出 `VERSION`。`checkUpdate()` 读取 `https://registry.npmjs.org/pi-endpoints/latest`，用 `isNewer()` 按数字逐段比较 `x.y.z`，带预发布后缀的版本不比较。成功的结果在进程内缓存 6 小时；失败（超时 10 秒）时沿用上次的结果，30 分钟后再试。查询可能要等几秒，所以页面先用 `/api/state` 渲染，再由 `showVersion()` 单独请求 `/api/update`，有新版时在版本号右边加上指向 GitHub Release 的绿色箭头。

`testModel` 用 `@earendil-works/pi-ai/compat` 的 `completeSimple()` 按当前解析出的参数发一条消息，Anthropic 协议的模型同样经过 `withBetas()`，超时 60 秒。请求带 `thinkingLevel` 时，把它作为 `completeSimple()` 选项里的 `reasoning` 发送，由 pi 按模型的 `thinkingLevelMap` 转换；不带时不设置思考档位。失败时返回 pi 给出的 `errorMessage`，其中包含服务端的原始错误。

## 依赖和导入

- `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 由 pi 提供，放在 `peerDependencies: "*"`。`devDependencies` 里的同名包只用于类型检查和测试。
- pi 加载插件时把这些包名映射到宿主自己的副本。映射只覆盖包根和 `@earendil-works/pi-ai` 的 `compat`、`providers/all`、`oauth` 子路径，导入其他子路径会绕过映射。
- 插件里的 `fetch` 在 pi 里会走 pi 配置的 HTTP 代理（pi 启动时替换全局 `fetch`）。单独用 Node 运行代码时，需要自己设置代理。
- 只使用可以直接擦除的 TypeScript 语法（`tsconfig.json` 开启了 `erasableSyntaxOnly`），不用参数属性和 `enum`，这样代码也能被 Node 的类型擦除直接运行。

## 测试

`npm test` 运行 `test/` 下的单元测试：

- `catalog.test.ts`：目录解析、合并和请求顺序，用 `vi.stubGlobal("fetch")` 模拟服务端。
- `modelsdev.test.ts`：models.dev 的字段映射、裁剪、服务商名单和匹配顺序；下载时机，包括 24 小时检查间隔、失败后 30 分钟、304、超时、同时只发一个请求、重新读取别的 pi 写入的文件和损坏的文件。用 `vi.stubGlobal("fetch")` 模拟 models.dev，用 `Date.now` 的替身控制时间。
- `resolve.test.ts`：参数分层（含 models.dev 层）、思考档位、协议选择、compat 的逐字段合并和 `null`、价格和 Anthropic beta 规则，用 `setBuiltinCatalogForTest()` 换掉 pi 自带目录，用 `setModelsDevForTest()` 换掉 models.dev 数据。整份写在配置里的手动 compat 合并后结果不变，也有测试覆盖。
- `endpoints.test.ts`：注册条件、停用服务、密钥和请求头的转义、环境变量、缓存、改名和删除、输入校验（含 compat 字段值为 `null`）、models.dev 的启动读取、是否需要下载、`refreshModels` 后台下载后重新注册且不循环、非对话模型不注册也不能启用、刷新期间的并发修改、多个 pi 进程、损坏的配置文件；以及经过服务商 `streamSimple`、由模拟 `fetch` 捕获的请求中，Anthropic 会话亲和头遵守默认值、手动开关和会话 ID 条件，`anthropic-beta` 同时含有 pi 生成的 beta 和插件追加的 beta。
- `web.test.ts`：管理页的 token、Host 和 JSON 检查，各项操作，刷新时等待 models.dev 及其失败不算刷新失败，测试消息的思考档位校验和发送，写入 pi 默认模型时保留其他设置、拒绝写入损坏的 `settings.json`，以及版本比较和更新检查的缓存与失败处理。

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
