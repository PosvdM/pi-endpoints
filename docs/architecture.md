# 技术文档

本文写给修改 pi-endpoints 代码的人。使用方法见 [README](../README.md)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口。加载时用配置和缓存注册服务商，再注册命令，不访问网络。 |
| `src/config.ts` | 配置、密钥、缓存三个文件的类型和读写；决定交给 pi 的 `apiKey` 写法。 |
| `src/catalog.ts` | 请求和解析服务端模型目录。 |
| `src/builtin.ts` | 在 pi 自带的模型目录里按名字查模型，判断模型原厂。 |
| `src/resolve.ts` | 把目录、pi 自带目录和手动设置合并成 pi 的模型配置，记录每个值的来源；选择协议；生成 `thinkingLevelMap`。 |
| `src/betas.ts` | 决定 Anthropic 协议的模型要追加哪些 beta，并在请求体上追加。 |
| `src/defaults.ts` | 用 pi 的 `SettingsManager` 读写 pi 的默认模型。 |
| `src/endpoints.ts` | `Endpoints` 类，持有全部状态，负责注册和注销服务商、刷新目录、修改配置。 |
| `src/commands.ts` | `/endpoints` 命令：启动管理页并打开浏览器。插件只有这一个命令，所有操作都在管理页里完成。 |
| `src/web/server.ts` | 管理页的 HTTP 服务和接口。 |
| `src/web/page.html` | 管理页前端，单个 HTML 文件，原生 JS，没有构建步骤。 |

## 数据流

1. 插件加载时，`Endpoints` 读取 `endpoints.json`、`endpoints-auth.json` 和 `endpoints-cache.json`，对每个服务调用 `register()`。配置或密钥文件读不了时，把原因记在 `loadError`，按空配置继续加载，命令照常注册。
2. `register()` 用 `resolveService()` 合并出所有模型，筛出已启用的，调用 `pi.registerProvider(name, ProviderConfig)`。服务没有密钥或没有启用的模型时改为注销。
3. pi 调用服务商的 `refreshModels` 时（交互模式和 RPC 模式启动后、打开 `/model` 时），如果 `context.allowNetwork` 为真，就请求服务端目录、写缓存，然后返回最新的模型列表，由 pi 替换已注册的模型。
4. 管理页和命令的修改都经过 `Endpoints` 的方法。每个方法先调用 `beginChange()` 重新读取三个文件，在最新内容上改动、保存，再调用 `registerAll()` 重新注册。

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

三个文件都先写临时文件再改名，避免写到一半时留下损坏的文件。文件位置取自 pi 的 `getAgentDir()`，测试通过环境变量 `PI_CODING_AGENT_DIR` 把它换成临时目录。

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

## 合并参数

`resolveModel()` 对每项参数按顺序取值：手动设置 → 服务端目录 → pi 自带目录 → 默认值，并把来源记在 `Sourced.source` 里，管理页据此显示来源标签。

### 在 pi 自带目录里查找

用 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModels()`。它是同步函数，插件加载时就能调用；`ctx.modelRegistry` 只在命令和事件里才有，赶不上启动时注册。代价是拿不到 pi 从 pi.dev 下载的较新目录。

`candidateIds()` 依次给出要查的 id：原样；去掉最后一个 `/` 之前的前缀；再反复去掉档位后缀（`-high` 等）、日期后缀（`-20250929` 等）和变体后缀（`-reversed`、`-thinking`、`-preview`、`-latest`）。

`findBuiltin()` 先在原厂服务商里找，再在其他服务商里找，但跳过 `RESELLERS` 列出的服务商：转卖别家模型的（openrouter、github-copilot 等）和订阅套餐（`qwen-token-plan*`、`kimi-coding` 等），它们的参数和原厂不一定一致。pi 新增这类服务商时要补进名单。

去掉前缀以外的后缀才匹配上时，不借用 pi 自带的显示名，否则 `claude-opus-5-5` 和 `claude-opus-5-5-high` 在 `/model` 里会显示成同一个名字。

### 原厂

`vendorOf()` 判断原厂是 `anthropic`、`openai`、`google` 还是 `xai`，原厂决定 compat 和价格从哪里抄。模型名里有 `claude`、`gemini`、`gemma`、`grok` 时以名字为准，因为 one-api 类中转站常把经 OpenAI 兼容渠道提供的 Claude 也标成 `owned_by: openai`；其余情况先看 `owned_by`，再看名字里的 `gpt`、`codex`、`o1` 这类写法。

协议选择（见下文）仍然先看 `owned_by`：这类中转站上的 Claude 可能确实只支持 OpenAI 协议，要靠管理页的测试消息确认。

### compat

- 从原厂在 pi 自带目录里的同名条目抄。
- GPT 模型在 ChatGPT 订阅类服务上（`Catalog.codex` 为真，或 `owned_by` 为 `codex`）改抄 `openai-codex` 的条目。官方 `openai` 条目里的 `supportsStrictMode`、`supportsExplicitPromptCacheMode` 等是官方 API 的能力，订阅版没有。
- 只有原厂条目的协议和模型实际使用的协议属于同一族时才抄（`openai-codex-responses`、`azure-openai-responses` 和 `openai-responses` 算同一族）。例如手动把 Claude 改成走 `openai-completions` 后，Anthropic 的 compat 不再适用。
- 模型不支持调节思考时，去掉 `forceAdaptiveThinking` 和 `supportsMidConvoEffort`。带着这两个标志，pi 的 Anthropic 实现会忽略 `reasoning: false`，照样发送 adaptive thinking 和 `effort`。
- 上下文、思考档位等参数不跟着 compat 抄，仍按上面的顺序取值。

在 CLIProxyAPI 上用真实请求验证过的组合：GPT-6 系列抄 `openai-codex` 的 compat 后，工具调用、文件编辑、对话中途换思考档位和换模型都正常；Claude Opus 5.5 抄 `anthropic` 的 compat 后，adaptive thinking 和工具调用正常。

### 价格

按原厂从 pi 自带目录抄官方 API 价格。GPT 一律找 `openai`，不找订阅版。找不到时为 0。

### 思考档位

`levelsToMap()` 把服务端列出的档位转成 pi 的 `thinkingLevelMap`：

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
- 已启用但目录里没有的模型仍然注册，用 pi 自带目录和默认值补齐参数。读过目录后，这类模型在管理页里标为"目录里没有"；还没读过目录时不标。

## pi 默认模型

管理页的星标读写的是 pi 自己的设置：`~/.pi/agent/settings.json` 里的 `defaultProvider` 和 `defaultModel`。`src/defaults.ts` 用 pi 导出的 `SettingsManager` 写入，效果和在 pi 的 `/model` 里按 Ctrl+S 相同：

- `SettingsManager` 写文件时加锁，只合并改动的字段，不会覆盖其他 pi 进程或 pi-sync 同时写入的设置。
- 设置了 `enabledModels`（Ctrl+P 轮换列表）时，pi 会把新的默认模型加进去，这里也照做。pi 先按展开后的模型判断是否已在列表里，这里只比对完整的模型名，列表里的通配符已经覆盖这个模型时会多加一条。要不要加先算好再写，列表格式不对时不会只写了一半。
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

- `GET /api/state` 返回全部状态，包括 `loadError`。
- `POST /api/<操作>` 执行 `saveService`、`removeService`、`setKey`、`setEnabled`、`setOverride`，成功时返回最新状态，失败时返回 400 和 `{ error }`。
- `refresh` 总是返回 200 和最新状态；刷新失败时状态里多一个 `refreshError`。
- `testModel` 返回 `{ test: { ok, stopReason, text, error, durationMs, request } }`。
- `saveService` 带 `previousName` 表示修改已有服务（可以改名），不带表示新建，新建时重名会报错。可以带 `apiKey`，和服务一起保存。新建服务时只要拿得到密钥（`apiKey` 或密钥环境变量），就接着刷新目录；刷新失败时服务已经保存，和 `refresh` 一样返回 200 和带 `refreshError` 的状态。

页面的状态变化后，`render()` 重建整个内容区，包括操作失败时显示错误。服务表单因此把还没保存的内容记在 `serviceDraft` 里，按服务名区分，重建时优先用它；保存成功、切换服务或点"添加服务"时清掉。新增其他会被 `render()` 重建的表单时，也要这样保存输入。打开页面后，以及在左栏重新启用服务后，`refreshInBackground()` 在后台调用 `refresh`，失败原因只显示在服务状态里，不弹顶部提示。这是唯一不由用户操作触发的重画，所以由 `flush()` 把它推迟到没有文字输入框获得焦点、也没有按着鼠标的时候，免得输入框失去焦点、没保存的密钥被清掉，或者点击落在被替换掉的元素上。`refreshing` 记下正在刷新的服务，这些服务的"刷新目录"按钮显示"刷新中…"并且不能点，手动刷新也用它。密钥框只出现在添加服务的表单里，已有服务的密钥在单独的密钥卡片里修改。密钥框用 `type="password"` 加 `autocomplete="one-time-code"`，免得 Chrome 把网站的已存密码填进来：密码框会忽略 `off`，`new-password` 会弹出生成密码。添加服务时，`slugify()` 按显示名生成名字，用户手动改过名字后停止跟随，把名字清空后重新跟随。

模型列表的分组和排序只在前端做，规则在 `page.html` 里：`prefixOf()` 取模型 id 的前缀（去掉 `/` 之前的部分，取第一段，去掉末尾的数字，转小写），分组和前缀按钮按 `byPrefix()` 排序：`PREFIX_ORDER` 里的前缀按列表顺序排在前面，其余按字母序；`newestFirst()` 按 `versionOf()` 从模型名里取出的版本号从大到小排。版本号最多三位数字，可以带一个字母后缀（`4o`）；参数规模（`120b`）和日期（`2024-08-06`、`20250929`）不算版本号。"已启用"页列的是点按钮时已启用的模型（`pinned`），停用的模型留到下次点按钮或刷新页面，免得开关一点模型就从眼前消失。左栏的服务也这样处理：`parked` 记下页面打开时每个服务是否停用，`serviceGroups()` 按这份记录把服务分成启用和停用两组，组内保持配置文件里的顺序；打开页面后新加的服务按加入时的状态归组。

`testModel` 用 `@earendil-works/pi-ai/compat` 的 `completeSimple()` 按当前解析出的参数发一条消息，Anthropic 协议的模型同样经过 `withBetas()`，不设置思考档位，超时 60 秒。失败时返回 pi 给出的 `errorMessage`，其中包含服务端的原始错误。

## 依赖和导入

- `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 由 pi 提供，放在 `peerDependencies: "*"`。`devDependencies` 里的同名包只用于类型检查和测试。
- pi 加载插件时把这些包名映射到宿主自己的副本。映射只覆盖包根和 `@earendil-works/pi-ai` 的 `compat`、`providers/all`、`oauth` 子路径，导入其他子路径会绕过映射。
- 插件里的 `fetch` 在 pi 里会走 pi 配置的 HTTP 代理（pi 启动时替换全局 `fetch`）。单独用 Node 运行代码时，需要自己设置代理。
- 只使用可以直接擦除的 TypeScript 语法（`tsconfig.json` 开启了 `erasableSyntaxOnly`），不用参数属性和 `enum`，这样代码也能被 Node 的类型擦除直接运行。

## 测试

`npm test` 运行 `test/` 下的单元测试：

- `catalog.test.ts`：目录解析、合并和请求顺序，用 `vi.stubGlobal("fetch")` 模拟服务端。
- `resolve.test.ts`：参数分层、思考档位、协议选择、compat、价格和 Anthropic beta 规则，用 `setBuiltinCatalogForTest()` 换掉 pi 自带目录。
- `endpoints.test.ts`：注册条件、停用服务、密钥和请求头的转义、环境变量、缓存、改名和删除、输入校验、刷新期间的并发修改、多个 pi 进程、损坏的配置文件；以及经过服务商 `streamSimple` 发出的真实请求里，`anthropic-beta` 同时含有 pi 生成的 beta 和插件追加的 beta。
- `web.test.ts`：管理页的 token、Host 和 JSON 检查，各项操作，以及写入 pi 默认模型时保留其他设置、拒绝写入损坏的 `settings.json`。

`test/helpers.ts` 提供临时的 pi 配置目录和只记录注册调用的假 `ExtensionAPI`。

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
