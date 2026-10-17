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
| `src/endpoints.ts` | `Endpoints` 类，持有全部状态，负责注册和注销服务商、刷新目录、修改配置。 |
| `src/commands.ts` | `/endpoints` 命令和终端里的模型勾选界面。 |
| `src/web/server.ts` | 管理页的 HTTP 服务和接口。 |
| `src/web/page.html` | 管理页前端，单个 HTML 文件，原生 JS，没有构建步骤。 |

## 数据流

1. 插件加载时，`Endpoints` 读取 `endpoints.json`、`endpoints-auth.json` 和 `endpoints-cache.json`，对每个服务调用 `register()`。
2. `register()` 用 `resolveService()` 合并出所有模型，筛出已启用的，调用 `pi.registerProvider(name, ProviderConfig)`。服务没有密钥或没有启用的模型时改为注销。
3. pi 调用服务商的 `refreshModels` 时（交互模式启动后、打开 `/model` 时），如果 `context.allowNetwork` 为真，就请求服务端目录、写缓存，然后返回最新的模型列表，由 pi 替换已注册的模型。
4. 管理页和命令的修改都经过 `Endpoints` 的方法：保存配置，再调用 `register()` 重新注册。

## 注册方式

使用 pi 旧式的 `pi.registerProvider(name, ProviderConfig)`。它允许每个模型单独设置 `api`、`baseUrl`、`headers`、`compat` 和 `thinkingLevelMap`，流式请求交给 pi 自带的协议实现。

这种写法下，`refreshModels` 返回的结果 pi 只放在内存里，不会存盘，所以插件自己维护 `endpoints-cache.json`，保证服务连不上时也能启动。

插件加载后再次调用 `registerProvider` 会立即生效，所以配置修改不需要重启 pi。

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
- `overrides` 的字段见 `src/config.ts` 的 `ModelOverride`。`thinkingLevels` 是 pi 的档位名列表，空数组表示不支持调节思考；也可以直接写 `thinkingLevelMap`，它优先于 `thinkingLevels`。

`endpoints-auth.json` 的格式是 `{ "<服务名>": { "apiKey": "..." } }`。在 macOS 和 Linux 上写入时把权限设为 600。

`endpoints-cache.json` 的格式是 `{ "<服务名>": Catalog }`，`Catalog` 见 `src/catalog.ts`。文件损坏时当作没有缓存。

三个文件都先写临时文件再改名，避免写到一半时留下损坏的文件。文件位置取自 pi 的 `getAgentDir()`，测试通过环境变量 `PI_CODING_AGENT_DIR` 把它换成临时目录。

## 密钥

- 设置了 `apiKeyEnv` 且该环境变量有值时，交给 pi 的 `apiKey` 是 `${NAME}`，由 pi 在请求时读取环境变量。
- 否则用文件里的密钥。pi 会把 `apiKey` 里的 `$NAME` 当作环境变量、把开头的 `!` 当作命令，所以要先用 `escapeConfigValue()` 转义：`$` 写成 `$$`，开头的 `!` 写成 `$!`。
- 管理页的测试消息和目录请求直接使用原始密钥，不经过 pi 的转义规则。

## 读取模型目录

`fetchCatalog()` 发两个请求：

1. `GET {root}/v1/models`。所有服务都支持，返回 `{ data: [...] }`，至少有 `id` 和 `owned_by`。Magpie 这类服务在每个模型上还带 `display_name`、`context_window`、`max_output_tokens`、`modalities.input`、`supported_reasoning_levels`、`native_endpoints`。
2. `GET {root}/v1/models?client_version=pi`。CLIProxyAPI 对它返回 Codex 格式 `{ models: [...] }`，带 `slug`、`context_window`、`max_tokens`、`input_modalities`、`supported_reasoning_levels`、`visibility`。按 `slug` 合并进第一步的结果，`Catalog.codex` 设为 `true`。其他服务会忽略这个参数或报错，这时只用第一步的结果。

第一步的结果必须保留，因为 Codex 格式里没有 `owned_by`，而选择协议要用它。

解析规则：

- 输入类型只保留 `text` 和 `image`，pi 不认识的（如 `pdf`）丢掉。
- `supported_reasoning_levels` 缺失时为 `undefined`（未知，交给下一层），为空数组时表示服务端明确不支持调节思考。
- `visibility: "hide"` 的模型标为隐藏，列表里默认不显示，但仍可启用。

## 合并参数

`resolveModel()` 对每项参数按顺序取值：手动设置 → 服务端目录 → pi 自带目录 → 默认值，并把来源记在 `Sourced.source` 里，管理页据此显示来源标签。

### 在 pi 自带目录里查找

用 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModels()`。它是同步函数，插件加载时就能调用；`ctx.modelRegistry` 只在命令和事件里才有，赶不上启动时注册。代价是拿不到 pi 从 pi.dev 下载的较新目录。

`candidateIds()` 依次给出要查的 id：原样；去掉最后一个 `/` 之前的前缀；再反复去掉档位后缀（`-high` 等）、日期后缀（`-20250929` 等）和变体后缀（`-reversed`、`-thinking`、`-preview`、`-latest`）。

`findBuiltin()` 先在原厂服务商里找，再在其他服务商里找，但跳过 `RESELLERS` 列出的转卖服务商（openrouter、github-copilot 等），它们的参数和原厂不一定一致。

### 原厂

`vendorOf()` 先看 `owned_by`，再看模型名，判断原厂是 `anthropic`、`openai`、`google` 还是 `xai`。原厂决定 compat 和价格从哪里抄。

### compat

- 从原厂在 pi 自带目录里的同名条目抄。
- GPT 模型在 ChatGPT 订阅类服务上（`Catalog.codex` 为真，或 `owned_by` 为 `codex`）改抄 `openai-codex` 的条目。官方 `openai` 条目里的 `supportsStrictMode`、`supportsExplicitPromptCacheMode` 等是官方 API 的能力，订阅版没有。
- 只有原厂条目的协议和模型实际使用的协议属于同一族时才抄（`openai-codex-responses` 和 `openai-responses` 算同一族）。例如手动把 Claude 改成走 `openai-completions` 后，Anthropic 的 compat 不再适用。
- 模型不支持调节思考时，去掉 `forceAdaptiveThinking` 和 `supportsMidConvoEffort`。带着这两个标志，pi 的 Anthropic 实现会忽略 `reasoning: false`，照样发送 adaptive thinking 和 `effort`。
- 上下文、思考档位等参数不跟着 compat 抄，仍按上面的顺序取值。

在 CLIProxyAPI 上用真实请求验证过的组合：GPT-6 系列抄 `openai-codex` 的 compat 后，工具调用、文件编辑、对话中途换思考档位和换模型都正常；Claude Opus 5.5 抄 `anthropic` 的 compat 后，adaptive thinking 和工具调用正常。

### 价格

按原厂从 pi 自带目录抄官方 API 价格。GPT 一律找 `openai`，不找订阅版。找不到时为 0。

### 思考档位

`levelsToMap()` 把服务端列出的档位转成 pi 的 `thinkingLevelMap`：

- pi 的档位是 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。服务端列出的照原样映射，没列出的设为 `null`。
- `off` 只在服务端列出 `none` 或 `off` 时开放，值为 `none`。OpenAI 协议把这个值原样作为 `reasoning.effort` 发送，其他协议不看具体值。
- `ultra` 这类 pi 没有的档位丢弃。
- 所有档位都是 `null` 时，`reasoning` 设为 `false`。

`supportedLevels()` 复刻 pi 的 `getSupportedThinkingLevels()`：`null` 的档位不可选；`xhigh` 和 `max` 必须明确写出才可选；`off`、`minimal`、`low`、`medium`、`high` 没写时可选。所以 `off` 必须显式设为 `null`，否则 pi 会提供"关闭思考"，在 OpenAI 协议上发出 `reasoning.effort: "none"`，订阅类服务会以 400 拒绝。

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
- 没有密钥时不注册，pi 会以 `no authentication method configured` 拒绝。
- 已启用但目录里没有的模型仍然注册，用 pi 自带目录和默认值补齐参数，并在管理页和 `/endpoints status` 里标出。

## 管理页

`startWebUI()` 在 `127.0.0.1` 的随机端口启动 HTTP 服务，`session_shutdown` 时关闭。防护措施：

- 每次启动生成 24 字节的随机 token。页面地址带 `?token=`，页面把 token 写进 `<meta>`，之后的接口请求放在 `x-endpoints-token` 请求头里。比较时用 `timingSafeEqual`。
- `Host` 请求头必须是 `127.0.0.1:<端口>`，防止 DNS 重绑定。
- 修改操作只接受 `POST` 和 `application/json`。跨站页面发这种请求必须先通过 CORS 预检，而服务不响应预检。
- 页面带 `Content-Security-Policy`，只允许内联脚本和样式，以及对本机接口的请求。
- 接口不返回密钥，只返回密钥来源（`file` 或 `env`）。

接口：`GET /api/state` 返回全部状态；`POST /api/<操作>` 执行 `saveService`、`removeService`、`setKey`、`refresh`、`setEnabled`、`setOverride`、`testModel`，成功后返回最新状态。`saveService` 带 `previousName` 表示修改已有服务（可以改名），不带表示新建，新建时重名会报错。

`testModel` 用 `@earendil-works/pi-ai/compat` 的 `completeSimple()` 按当前解析出的参数发一条消息，不设置思考档位，超时 60 秒。失败时返回 pi 给出的 `errorMessage`，其中包含服务端的原始错误。

## 依赖和导入

- `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 由 pi 提供，放在 `peerDependencies: "*"`。`devDependencies` 里的同名包只用于类型检查和测试。
- pi 加载插件时把这些包名映射到宿主自己的副本。映射只覆盖包根和 `@earendil-works/pi-ai` 的 `compat`、`providers/all`、`oauth` 子路径，导入其他子路径会绕过映射。
- 插件里的 `fetch` 在 pi 里会走 pi 配置的 HTTP 代理（pi 启动时替换全局 `fetch`）。单独用 Node 运行代码时，需要自己设置代理。
- 只使用可以直接擦除的 TypeScript 语法（`tsconfig.json` 开启了 `erasableSyntaxOnly`），不用参数属性和 `enum`，这样代码也能被 Node 的类型擦除直接运行。

## 测试

`npm test` 运行 `test/` 下的单元测试：

- `catalog.test.ts`：目录解析、合并和请求顺序，用 `vi.stubGlobal("fetch")` 模拟服务端。
- `resolve.test.ts`：参数分层、思考档位、协议选择、compat 和价格规则，用 `setBuiltinCatalogForTest()` 换掉 pi 自带目录。
- `endpoints.test.ts`：注册条件、密钥存放、环境变量、缓存、改名和删除。
- `web.test.ts`：管理页的 token、Host 和 JSON 检查，以及各项操作。

`test/helpers.ts` 提供临时的 pi 配置目录和只记录注册调用的假 `ExtensionAPI`。

真实服务的验证在 pi 里进行，例如：

```bash
pi -e . --list-models
pi -e . --no-session -p --model cpa/gpt-6.1-sol:high "Reply with exactly: OK"
```

非交互模式不执行扩展命令，`/endpoints` 需要在交互界面或 RPC 模式（`pi --mode rpc`）里测试。
