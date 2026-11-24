# Loom context / Host 接入契约

## 构造与依赖

```js
import { createLoomContext } from './context/index.mjs';

const context = await createLoomContext(ctx, {
  directory,       // 当前实例独占的持久目录
  workspaceId,     // 已注册的专用控制工作区 ID
  getSettings,     // 同步读取 {roleModels, context, permissionPreset}
  query,           // async request => core 查询结果
  command,         // async (request, actor) => core 命令结果
  modelCatalog,    // async () => 原生目录，含 default:{provider,model}
  resolveBus: id => ctx.sessionController.resolveAgent(id),
});
const current = await context.ensureBus();
```

Host 提供 `agents / llm / systemPrompt / tools / tokenMeter / workspaceRegistry / permissionPresets`，并加载原生 Session persistence、AgentLoop 和工具 executor。嵌入原生界面时，`resolveBus` 使用同一 `sessionController` 的恢复去重入口；独立装配可省略此选项，由 manager 持有恢复句柄。历史恢复使用 `sessionPersistence` 校验并定位会话日志。

插件通过 `createRequire` 加载以下原生 peer 依赖；版本与宿主对齐，解析位置以插件安装目录为基准：

- `@deepseek-ai/dsh-tools`：工具定义。
- `@deepseek-ai/dsh-llm`：消息构造。
- `@deepseek-ai/dsh-compaction`：工具交互配对函数，以库函数方式调用。
- `@deepseek-ai/dsh-session`：交接记录及会话恢复。
- `@deepseek-ai/dsh-session-format`、`@deepseek-ai/dsh-session-format-v3-to-v4`：持久日志解码和关系校验。

Host 构建将这些包保留为外部依赖，由宿主兼容版本提供。可选 `sessionLogDeepSeek` 服务通过 `ctx.inject` 动态绑定，为当前 manager 所有的会话注册日志上传排除项；服务后加载时同样生效，释放 manager 时撤销。

## 返回接口

| 方法 | 契约 |
| --- | --- |
| `ensureBus()` | 返回 `Promise<{sessionId,busId,segment,previousSessionId?}>`。创建或恢复当前总线，并在空闲时应用设置和检查分段条件。并发调用共享一次维护，忙碌时返回当前身份。 |
| `getBus()` | 同步返回当前持久身份的副本或 `null`。会话加载与恢复由 `ensureBus()` 完成。 |
| `getUsage({limit?,key?})` | 读取当前逻辑总线的逐轮用量摘要，或按轮次键读取调用明细。与 `loom/usage` 共用查询契约。 |
| `getStatus()` | 返回 `{workspaceId,bus,status,focus,pending,maintenanceError,config,wire}`；会话尚待加载时 `status` 为 `unloaded`。维护失败保存错误码和 `retryable`，后续 `ensureBus()` 可重试。 |
| `evaluateWork(work,run,checks,signal)` | 返回 `{passed,summary,source,evidence}`。客观检查失败或缺项时直接返回失败结果，其余调用原生 `llm.stream` 生成预验收意见。模型、传输和 JSON 错误拒绝 Promise，由 Host 保存诊断。 |
| `bindAgent(agent)` | 在原生创建或恢复的 maintenance 内，为当前总线绑定完整工具、system、输入与历史整理策略。 |
| `bindCurrent()` | 复用已完成的当前绑定；既有普通 agent 先关闭下一轮准入，待空闲后在 maintenance 内安装策略。 |
| `dispose()` | 中止辅助验收并等待活动 iterator；释放自有句柄，原生持有的总线保留关闭门禁供后续重新绑定。释放 manager 级 hook、fetch wrapper 和排除项。并发调用共享 Promise；清理结束后统一抛出收集到的错误。 |

模型选择结构为 `{provider,model,reasoningEffort?}` 或 `null`。`review/acceptance` 缺省沿用 `bus`，`bus` 缺省使用 `modelCatalog().default`；选择作用于所属会话及辅助调用。`worker` 由 Host 管理。总线在创建、恢复、空闲维护及下一次 pre-step 时读取模型设置。

执行权限通过 `permissionPreset` 选择。总线在 setup 和空闲维护时应用原生权限预设；`null` 保留会话现有权限。工作运行的权限快照由 Host 与 core 管理。

预验收模型输出为 `{passed:boolean,summary:string,evidence:string[]}`，通过时要求至少一条证据。返回结果绑定 Work、Run、模型、检查、输入摘要及用量；最终业务验收由 core 的用户命令或工作流授权处理。

## 总线与原生界面

客户端以 `ensureBus()` 返回的 `sessionId` 连接原生会话。空闲维护可能切换物理段，客户端应跟随 `getBus()` 的当前身份；历史段以只读 transcript 展示。

总控的每个新会话段在发布段 ID 前，由 DSH 的 `workspace.attachSession` 登记到控制工作区。插件启动时依据总控索引补登记仍存在的当前段和历史段，保留原会话 ID。历史段被宿主拒绝时，记录诊断并继续登记其他段。控制目录下的普通会话继续由 DSH 按自身登记分组。

bundle 通过原生启动依赖在 AgentLoop factory 就绪前加载 `dsh-loom/bootstrap`。启动保护限于专用控制工作区；总线创建和恢复在 awaited `agent/created` 中等待完整策略绑定。主插件与启动保护共用配置目录及 binding registry，绑定就绪后开放 Loom 接口。原生持有的 agent 可在插件重载后重新绑定；句柄的释放仍由其原始 owner 管理，缓存状态以 registry 中的实例为准。

总线使用完整、稳定的 system section，动态焦点通过独立 context section 注入。工具范围为 `loom_query / loom_command / loom_focus`；参数统一为 `{request: JSON字符串}`，输出为 JSON 字符串。

- `loom_query` 只读返回有界摘要或完整详情页。列表的 `nextCursor` 作为下一次 `after`；详情的 `next` 是完整下一页请求。
- `loom_command` 使用固定身份 `{kind:'agent',sessionId}`，提案和用户确认进入同一 core。`proposed` 提案与 `awaiting_model` 工作的回执含 `waitingFor:'user_confirmation'` 和等待用户在工作台确认的说明。
- `loom_focus` 保存项目、工作、工作流、约束与指代等焦点信息，也可准备关联原生回复的编号清单。

### 编号清单与指代

调用 `loom_focus` 的 `{display:[{kind,id},...]}`，按展示顺序提供 1–12 项。支持 `workspace`、`work`、`workflow` 和 `use`。工具从业务核心核对对象和显示名，返回 `text`。总控将 `text` 原样作为最终回复；同一原生轮次正常结束且最终助手文本匹配时，写入最近清单及 `sessionId`、`replyId`、`shownAt`，每项带项目、对象及展示版本。编号清单随总控状态保留，普通查询、详情与返工影响读取共用只读路径。

用户引用“第二项”等时，先用 `loom_query {kind:'bus.display',position:2,replyId?}` 核实来源，并按持久 ID 读回对象的当前版本和状态，再通过正常命令入口执行。无可靠清单、来源不符或对象消失时返回 `LOOM_REFERENCE_UNCLEAR`；同名或属于其他清单的指代需要向用户澄清。该协议适用于带编号的正式清单回复。

### 工具装配与身份

`tools.mjs` 导出 `createContextTools({defineTool,query,command,state,config,sessionId,stageDisplay})`，返回上述三个原生工具定义。`config()` 读取当前配置，`state` 为当前 `BusState`；`query/command` 与工作台使用同一持久业务核心。`BUS_TOOL_GUIDANCE` 提供稳定的产品及操作说明，供总控 system section 组合。

原生 `defineTool` 的参数格式为属性映射，生成的根 object schema 保持开放。工具执行体显式要求根参数仅有 `request`，将其解析为 JSON object；业务命令递归检查授权字段。焦点中的会话引用和约束说明按记忆数据保存，执行授权读取 core 持久记录。`actor/authorization/modelConsent/checksConsent/confirmation` 属于持久来源字段；嵌套 `autoAccept/permissionPreset/sessionId/requestId/callId/turn` 及原型访问键被拒绝。根 `autoAccept/permissionPreset` 用于本次提案选项；根 `sessionId` 用于关联工作会话。具名输入中的 `workId` 结果引用及业务 `model` 数据保持可用。

用户确认、授权、模型/检查同意、关卡释放、设置和人工验收由用户 API 提交。core 根据入口 actor 检查；`work.rework` 在已有消费者时同样要求用户身份和当前影响令牌。

### 提案、保存与复用

面向用户使用“项目、工作、工作流”。use 是保存本次提案、定义快照和工作归组的内部记录。

| 操作 | 模型命令与结果 |
| --- | --- |
| 执行一次 | `use.create {workspaceId,definition,parameters?,model?,permissionPreset?,autoAccept?,reviewRequired?,idempotencyKey?}`，返回 `{use,works}`；待审阅为 proposed，按设置排队为 confirmed。 |
| 保存为工作流并执行 | 先 `workflow.create {workspaceId,title,description?,knowledge?,parameters?,stages}`，再 `workflow.start {workflowId,expectedVersion,parameters?,model?,permissionPreset?,autoAccept?,idempotencyKey?}` 创建提案。 |
| 再次使用 | 查询当前定义及其版本，为新输入调用 workflow.start；按发布策略生成工作或保存提案。workflow.start、use.create、work.create 支持 `reviewRequired:true`。workflow.start、use.create、use.update 可附 `stageInputs:[{stageId,name,value}]`；参数和上游输出仍按原绑定传入。 |
| 修改待确认内容 | `use.update {useId,expectedVersion,definition?,parameters?,model?,permissionPreset?,autoAccept?}`；来源定义被改写时形成 inline 提案并保留来源信息。 |
| 修改工作流 | `workflow.update {workflowId,expectedVersion,definition}` 完整替换定义；已有工作保持采用的说明与输入。 |
| 完成后保存 | 用完整定义调用 workflow.create，并给出同项目已验收的 `sourceWorkIds` 及 `{[workId]:version}` 形状的 sourceVersions；原工作与证据保持。 |
| 独立工作 | `work.create {workspaceId,title,description?,scope?,model?,permissionPreset?,sessionId?,dependsOn?,manualGate?,checks?,inputs?,outputs?,reviewRequired?}` 返回 queued 或 awaiting_model 工作。 |

定义为 `{title,description?,knowledge?,parameters?,stages}`，须含至少一步。参数为 `[{name,description?,required?,default?}]`；步骤为 `{id,title,instructions?,scope?,dependsOn?,manualGate?,checks?,inputs?,outputs?}`。具名输入支持 value、parameter 和前序步骤 output；具体工作使用 value/result 引用。输出声明为 `[{name,description?,required?}]`。完整格式及边界见 core 契约。

总控先查已有说明，再补齐本次目标、输入及可用方法。按实际回执报告下一步。工作台以 `use.confirm {useId,expectedVersion}` 或 `work.confirm {workId,expectedVersion,autoAccept?}` 确认待审阅版本。用户确认保存模型、检查及本次权限同意。宿主自动排队由当前总控身份与保存的设置产生，记录 `host/bus-auto-start` 来源；命令检查、显式人工关卡和需用户决定的验收沿用原入口。

### 有界查询与完整详情

普通查询：

```js
{kind:'work'|'workflow'|'use'|'run'|'event'|'intent'|'workspace'|'control',
 workspaceId?,workflowId?,workId?,useId?,status?,categories?,legacy?,after?,limit?}
```

返回 `{items,total,nextCursor,summaryOnly:true}`。条数上限同时受 queryLimit 和 50 限制，实际页长可随字节预算缩小。摘要保留具名输入、输出、参数等动态字段；长文字保存预览、`truncated:true`、原 JSON 字节数及摘要散列。超过 20 项的数组返回 `{items,total,truncated:true}`，过深子树返回类型、条数及截断标记。单条记录摘要仍超预算时保留身份、版本、状态和 `detailRequest`，并设置 `truncated:true`。

`{kind:'rework',workId}` 返回有界的 `{workId,version,affected,impactToken,summaryOnly:true,detailRequest}`。超预算的 affected 为 `{total,truncated:true}`，完整影响通过详情查询。`{kind:'bus.history',after?,limit?}` 查询内部物理段历史，同样执行条数与字节限制。

详情请求：

```js
{kind:'workflow',workflowId,detail:true,section:'stages',offset:0,limit:2000}
{kind:'use',useId,detail:true,section:['definitionSnapshot','stages','0','inputs']}
{kind:'work',workId,detail:true,section:['result','outputs']}
{kind:'run',runId,workId?,detail:true,section:'consumedResults'}
{kind:'rework',workId,detail:true,section:'affected'}
```

每个 kind 使用精确目标 ID：workId/workflowId/useId/workspaceId/runId/intentId/eventId/controlId，rework 使用 workId。section 为顶层字段名或自有属性路径数组，省略时读取完整对象；数组下标写成字符串。run/event/intent/control 按现有核心分页定位目标，支持处于后续页的记录。

返回形状：

```js
{kind,id,version?,detail:true,section:[],revision,
 encoding:'json',unit:'codePoints',offset,count,total,text,truncated,next}
```

所选值先序列化为 JSON，再按 Unicode 码点分页。offset/count/total/limit 都以码点为单位；同一长步骤、深层对象或字符串均可拆页。将各页 text 顺序拼接，再 JSON.parse，即可恢复完整值。每次直接提交 next；结束时 next 为 null。revision 绑定本次读取的完整对象，期间状态或定义变化返回 CONFLICT，调用方从 offset 0 重新读取。列表游标与详情游标分别使用 after 和 next。

所有成功工具回执的 UTF-8 JSON 字节数受 queryMaxBytes 限制，包含 next、摘要标记和确认提示。详情页缩小实际 count 以适应预算；连游标与一个字符都无法容纳时返回 LOOM_QUERY_BUDGET。仅成功返回后更新查询展示顺序。

### 输入、结果版本、等待与返工

工作查询包含 inputs、outputs、result.outputs、wait 和 inputChanges；Run 详情包含实际 inputs、consumedResults、outputs 和 resultVersion。下游引用记录实际消费的工作、执行及结果版本，缺少必需结果时保持等待。

工作报告保存原操作 ID、远端引用及复查时间，或交出已经核对的来源和缺口。Host 到期唤醒当前总控，提醒失败按工作记录重试。自动轮的查询限本项目，写入绑定提醒的工作与版本。`loom_query` 的 `project.sessionSearch {workId,query}` 读取原工作及同项目其他会话的匹配摘录；`next` 提供续页请求。总控也可查项目知识、上游和相关工作结果。

以 `work.resolveWait {workId,expectedVersion,operationId,sources,action,...}` 处理同一操作：`continue` 保存线索并排回原工作，`wait` 设置下次复查，`ask` 保存具体问题并进入待处理。每次决定及来源各自留在工作事件中。工作队列沿用原 sessionId、操作 ID 和消费版本。取消本地跟踪后仍保留远端引用。

返工前查询 rework，向用户展示受影响工作及消费版本。已有消费者时由用户 API 提交当前 impactToken 和 rerunWorkIds；选定工作沿用原工作及会话，其余保留结果并标记 inputChanges。工作流修改只影响后续使用，原工作通过返工推进同一目标。

## 上下文与持久化

按回顾周期整理历史。回顾选区为连续且工具调用与结果配对完整的历史交互，保留 system、最新用户意图及最近交互。回顾成功且压缩有效后替换 surface；原生历史日志继续保留。失败时保存原 surface 和待处理输入。

待处理输入按消息 ID 去重，在下一次 pre-step 重试，写入原生日志后清除。长输入的焦点字段保存有界预览，实际请求使用完整原文。

当前段达到 `segmentMaxEvents`、总线空闲且输入队列已清空时，manager 生成有界交接记忆并创建新段。既有日志缺少受保护的 system 首记录时，恢复路径先核验日志身份、事件关系和完整交互，再迁移到新段。

`directory` 内的文件：

- `bus.json`：逻辑总线、当前物理段、焦点和 checkpoint。
- `pending.json`：待重新准入的消息。
- `segments/<序号>.json`：独立的有界历史索引，按页读取。
- `debug/wire-N.jsonl`：轮转请求日志。

状态文件通过独占临时文件、`fsync` 和 `rename` 提交。原生会话持久化由 Host 的 Session persistence 管理。

## 上下文设置与用量

`reviewEverySteps` 设置历史回顾周期，`reviewMaxTokens` 设置辅助模型输出长度。`segmentMaxEvents` 控制分段；段间交接内容超过 `checkpointMaxBytes` 时使用一次摘要。`queryLimit` 和 `queryMaxBytes` 用于业务查询分页。主请求使用宿主和模型的原生限制。

调用结束后，`wire.latest.usage` 保存适配器最后报告的用量。`wire.usageTotals` 按字段累计本实例运行期间的报告值，`wire.callsWithUsage` 为有报告值的调用数。输入、输出和缓存字段保持供应商口径，缺失表示未知；调用记录中的 `purpose` 区分总控、回顾和预验收。

`debug` 控制请求日志，默认关闭。开启时，同一模型调用以 `callId` 关联；可捕获的 HTTP JSON 请求保留脱敏后的内容。默认支持原生 HTTP 路由和宿主登记的 pi-ai 路由；`httpProviders` 可显式替换此名单。`debugMaxBytes` 和 `debugFiles` 限制本机日志容量，不改变发送给模型的内容。日志仍可能包含业务文本，分享前请检查。

### 逐轮用量诊断

`usage.sqlite` 独立保存最近 200 个已结束轮次以及在途记录，采集与 `debug`、正文日志轮转及会话历史保留分别运行。记录字段限总线、段、会话、轮次、步骤、调用身份、模型、时间、状态和数值用量。

- 原生 `turn/start`、`turn/end` 确定轮次边界和终态，原生 `step/start` 确定主请求步骤。调用开始时固定归属；最终用量凭 `callId` 更新同一条记录。同一流的累计回执取末份，流内 transport retry 不重复累计。步骤触发的回顾单列；换段回顾、标题、工作执行与预验收在各自范围运行。
- 已核实的 pi-ai、OpenAI Codex 和 DeepSeek Official 适配器输入口径是普通输入、缓存读取与缓存写入之和；未命中包括普通输入和缓存写入。pi-ai 路由取自宿主当前登记，不依赖部署专用名称。输出保持适配器口径，已计入的推理随输出一同显示。未知适配器要有可核对的数值才能给出总输入；缺失或冲突字段保留为未知。pi-ai 的全零快照可能来自适配器初始化。逐轮明细保留原值，成功调用标记 `adapter-unverified-zero`，失败或停止调用标记 `adapter-error-zero`；汇总按未报告处理。
- 摘要分别给出主对话、本轮回顾和合计。输入峰值取该组已知单次输入的最大值。`calls` 是观察到的调用数；`reported` 是有可信用量字段的调用数，`inputCount`、`outputCount` 分别说明有多少调用可参加该项合计。缺失值为 `null`；`unknownSplit` 是总输入已知但缓存拆分未知的部分。
- 历史查询以 `usage.sqlite` 中的数值记录为准。已存在总控会话的工作区首次初始化逐轮诊断时会记录 `LOOM_USAGE_LEGACY`，提示启用前的历史覆盖不全。既有数值仍可查询，已补录轮次保留 `legacy` 标记。数值库无法打开时，用量查询返回 `LOOM_USAGE_STORAGE`，总控与调度器继续运行。

`loom/usage {limit?}` 返回 `{items,error}`，按结束时间从近到远，默认及最多 20 轮。`loom/usage {key}` 返回该轮 `{key,calls,error}`；`key` 取自摘要。`error` 可报告存储或历史覆盖问题，同时保留已可读取的记录。诊断页面的图表和明细使用同一摘要，按需读取逐次调用。

业务状态与授权接口见 [持久业务核心契约](../core/README.md)。
