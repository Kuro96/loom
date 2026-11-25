# 持久业务核心契约

入口为 `store.mjs` 的 `LoomStore`，运行于 Node 24，使用 `node:sqlite`。构造参数为数据库路径，父目录由调用方准备。写入使用 `BEGIN IMMEDIATE`、WAL、`synchronous=FULL` 和 5 秒锁等待。业务状态、审计事件及命令幂等结果同事务提交。`schema.mjs` 定义输入边界，`migration.mjs` 负责历史结构升级。

## 对象与归属

- Workspace 是原生项目。`syncWorkspaces([{workspaceId,path,title}])` 接收完整 registry 快照；路径、名称或可用状态变化才提交和递增版本。缺席项目标记 `active:false`，保留业务记录及共享知识。
- Workflow 是可复用定义，保存 `title/description/knowledge/parameters/stages/version`。普通定义为 `available`；迁移的空步骤来源为只读 `legacy`。
- Work 是具体工作，保存输入、输出声明、模型与检查修订、创建时权限、授权、会话和结果。依赖可连接同一项目中的具体 Work。
- 内部 use 保存一次使用的提案、定义快照、参数及工作归组。状态为 `proposed/cancelled/confirmed`，用户确认后原子创建全部工作。每次新使用生成新 Work；返工沿用原 Work/session。
- Run 保存一次执行的 requestId、prompt、实际输入、消费版本、候选报告及结果。新执行生成新的 Run/requestId，主会话保持。调度在调用原生投递前保存尝试次数和起始游标。外部读写故障在当前 Run 记录 `nativeFault` 和诊断，按有上限的间隔查询原回执。原会话的队列和事件用于对账；重投沿用原 requestId，最多发出三次，之后继续核对。停止状态以原生会话、队列和后台活动读回为准；待核对期间保持项目互斥。

Workflow 的运行进度由 use 中的 Work 派生。定义更新作用于后续使用；已有 Work 的说明、范围、输入及定义知识快照保持。模型和检查有独立修订确认入口。

## 定义与具名输入

```js
{
  title: '上传并训练', description: '', knowledge: '',
  parameters: [{name: 'batch', description: '本次数据批次', required: true}],
  stages: [
    {id: 'upload', title: '上传', instructions: '上传选定批次', scope: '选定数据',
     inputs: {batch: {kind: 'parameter', path: ['batch']}},
     outputs: [{name: 'dataset', description: '远端数据集', required: true}]},
    {id: 'train', title: '训练', manualGate: true,
     inputs: {dataset: {kind: 'output', stageId: 'upload', output: 'dataset', path: ['id']}}}
  ]
}
```

步骤完整字段为 `{id,title,instructions,scope,dependsOn,manualGate,checks,inputs,outputs}`。依赖、检查、输出默认 `[]`，输入默认 `{}`。输出引用自动加入步骤依赖，创建时核对唯一 ID、输出声明及 DAG。

| 定义中的来源 | 确认后的 Work.inputs |
| --- | --- |
| `{kind:'value',value:JsonValue}` | 同一具名值 |
| `{kind:'parameter',path:['batch',...]}` | 解析为 `{kind:'value',value}` |
| `{kind:'output',stageId,output,path:[]}` | `{kind:'result',workId,output,path:[]}`，加入具体依赖 |

独立 work.create 的输入使用 value/result。参数默认值仅在参数缺席时使用，null 是实际 JSON 值。路径最多 8 段，仅访问自有属性。参数、输出和输入名称采用 `[A-Za-z_][A-Za-z0-9_-]*`；保留名为 `__proto__/prototype/constructor`。

定义和报告上限 256 KiB，规范化定义也核对上限。新定义含 1—1000 步骤；参数、输出及具名输入分别最多 100 项。JSON 深度最多 32 层，数值须有限。具体输入/输出声明合计同样受 256 KiB 边界约束；use.confirm 在参数展开后使用与 work.create 相同的校验，任一工作超限时全部工作、使用确认、审计和幂等记录整体回滚。说明文本原样保存，实际输入单独附在 Run.prompt；检查命令保持已批准的具体值。

## 命令、确认与幂等

`command(effectiveInput, actor, {identityInput=effectiveInput}={})` 是业务写入口，actor 为 Host 传入的 `{kind:'user'|'agent',sessionId?}`。普通命令返回持久对象；workflow.start/use.create/use.confirm 返回 `{use,works}`。

| type | 参数及行为 |
| --- | --- |
| workflow.create | `{workspaceId,title,description?,knowledge?,parameters?,stages,sourceWorkIds?,sourceVersions?}`。来源 Work 须同项目、已验收且版本一致；sourceVersions 为 `{[workId]:version}`，定义由调用者完整提供。 |
| workflow.update | `{workflowId,expectedVersion,definition}`，完整替换定义并递增版本。 |
| workflow.start | `{workflowId,expectedVersion,parameters?,stageInputs?,model?,permissionPreset?,autoAccept?,reviewRequired?}`，返回 `{use,works}`；待确认时 works 为 `[]`。 |
| use.create | `{workspaceId,definition,parameters?,stageInputs?,model?,permissionPreset?,autoAccept?,reviewRequired?}`，临时定义的 workflowId 为 null；发布结果同上。 |
| use.update | `{useId,expectedVersion,definition?,parameters?,stageInputs?,model?,permissionPreset?,autoAccept?}`，仅 proposed 可修改。提交完整 definition 时转为 inline，保留 sourceWorkflowId/sourceWorkflowVersion。 |
| use.confirm | `{useId,expectedVersion}`，仅用户；确认当前提案，原子生成全部工作及精确同意。重复原 proposalVersion 返回同组工作，其他版本冲突。人工关卡保持。 |
| use.cancel | `{useId,expectedVersion}`，仅用户。仅 proposed 可取消，返回含 progress 的 cancelled 提案，保留快照，版本递增，工作数为零。 |
| use.delete | `{useId,expectedVersion}`，仅用户。删除尚未生成工作的 proposed 或 cancelled 提案，返回 `{id,deleted:true}`。 |
| work.delete | `{workId,expectedVersion}`，仅用户。删除指定的具体工作及其 Loom 报告正文、运行和控制记录，返回 `{id,deleted:true}`。 |
| work.create | `{workspaceId,title,description?,scope?,model?,permissionPreset?,workflowId?,sessionId?,dependsOn?,manualGate?,checks?,inputs?,outputs?,reviewRequired?}`，创建 queued 或 awaiting_model 工作。 |
| work.confirm | `{workId,expectedVersion,autoAccept?}`，仅用户；一次确认当前模型、检查、权限及自动验收。 |
| work.authorize | `{workId,expectedVersion,autoAccept}`，仅用户；更新具体工作授权，影响尚未完成的执行及后续返工。 |
| use.authorize | `{useId,expectedVersion,autoAccept}`，仅用户；批量更新该次使用的具体工作授权，confirmation 历史保持。 |
| intent.create | `{text}`，保存归属待澄清草稿。 |
| intent.assignProject | `{intentId,workspaceId,expectedVersion}`，用户为待澄清请求指定有效项目，递增请求版本，继续保持 pending。旧请求的初始版本为 1。 |
| intent.resolve | `{intentId,workspaceId,workId?,useId?}`，以一个同项目的既有目标结清请求。已选项目须与目标一致；同目标重复结清保持原值。 |
| workspace.setKnowledge | `{workspaceId,knowledge,expectedVersion?}`，更新项目知识。 |
| workflow.setKnowledge | `{workflowId,knowledge,expectedVersion?}`，兼容的定义知识编辑入口；legacy 来源只读。 |
| settings.update | `{roleModels?,context?,permissionPreset?,busAutoStart?,expectedVersion?}`，仅用户，按字段合并设置。 |

`stageInputs` 按 `(stageId,name)` 修改本次使用的步骤输入。例如 `stageInputs:[{stageId:'upload',name:'manifest',value:['批次A.csv']}]` 会在 `use.definitionSnapshot` 的 upload 步骤新增或替换静态值 `manifest`。省略的输入保持原值；`value:null` 表示显式空值。参数引用通过 `parameters` 修改，上游输出引用由依赖工作提供。仅修改本次输入时保留 `workflowId/workflowVersion`；与完整 `definition` 同时提交时，先采用新定义，再应用覆盖。

每条覆盖须指定已有步骤、合法输入名和 JSON 值，同一命令的 `(stageId,name)` 须唯一。覆盖数组和合并后的定义分别受 256 KiB 限制，合并后每步最多 100 项输入。任一条无效时整个命令回滚。确认后，具体工作和执行均使用已保存的快照。

模型为 `{provider,model,reasoningEffort?}`。模型与权限在提案/Work 创建时解析：模型缺省使用 worker 设置，权限缺省使用当前设置，显式 null 表示沿用原生权限。autoAccept 默认 false。Host 确认前核对选择仍可用。新 Work.permissionPreset 冻结，Run 沿用该值；设置变更作用于新建对象。

use.confirmation 为 `{actor,at,proposalVersion}`。用户确认同时创建精确 modelConsent/checksConsent。`busAutoStart` 默认开启。Host 只为当前总控的发布请求提供对应设置版本和模型、项目权限；权限为 null 时自动路径使用 `workspace-write`。Store 在同一事务核对设置版本，记录 `host/bus-auto-start` 来源，按条件直接生成工作；命令检查、关联已有会话、不同模型或权限、显式先审阅等情况走原确认路径。自动批次的中间交接须有必需输出或客观检查，交接产出齐备、检查及预验收通过且没有用户交付文件时才自动验收。新 workflow.authorize 请求返回 MIGRATION_REQUIRED；历史幂等请求仍返回原响应。

所有命令支持 idempotencyKey。同键、原始请求及 actor 返回首次结果快照，内容或身份不同为 CONFLICT；对象键顺序保持等价。identityInput 用于 Host 补默认值前的原请求。`replayCommand(input,actor)` 返回旧结果或 undefined；Host 可先重放，再检查原生状态和提交，写事务会再次检查。更新/确认/授权/干预使用当前 expectedVersion。

### 提案取消与记录删除

取消提案后可查询取消记录；以当前版本修改、确认或再次取消返回 `INVALID_STATE`。整批删除的范围是该版本 `definitionSnapshot.stages` 中尚未生成工作的步骤。确认过的 use 保留，即使后来删除其最后一个工作。

具体工作删除仅在 Loom 数据库内进行。派发、运行、停止对账中或有待回执控制时返回 `INVALID_STATE`。其他工作依赖、具名输入、运行消费记录、工作流的来源工作或已关联意图引用目标时返回 `INVALID_DEPENDENCY`。删除成功后，从所属 use 的 `workIds/stageWorkIds` 移除该成员，更新 use 版本和进度；确认快照和同批其他工作保持。重试原提案版本的 `use.confirm` 返回现存成员。

三条命令在幂等重放前校验 Host 的用户身份；首次执行要求当前 `expectedVersion`，缺少或过期为 `CONFLICT`。记录变更、审计和幂等回执同事务提交。删除保留既有审计和按键保存的原响应快照；同一身份和请求重放原回执，新请求删除已删除对象返回 `NOT_FOUND`。项目文件与原生会话由各自宿主管理。

### 精确同意与控制

- `work.setModel {workId,model}`：闲置工作递增模型修订，清同意及旧结果；暂停保持。
- `work.approveModel {workId,modelRevision,expectedVersion}`：用户确认当前模型，进入 queued；暂停保持。
- `work.setChecks {workId,checks}`：闲置工作递增检查修订，清检查同意、自动验收授权及旧结果；清空检查同样适用。review 按模型同意重新排队。
- `work.approveChecks {workId,checksRevision,expectedVersion}`：用户确认精确检查定义及 SHA-256。
- `work.releaseGate {workId,expectedVersion}`：用户释放人工关卡。
- `work.steer {workId,text,expectedVersion}`：为 dispatching/running 工作追加持久干预控制；返回递增版本的 Work。
- `work.pause/work.cancel {workId}`：活动执行创建停止 outbox；闲置/外部等待直接暂停或取消，保留远端引用。
- `work.resume {workId}`：已暂停工作按模型同意进入 queued/awaiting_model。
- `work.accept {workId,runId,expectedVersion}`：用户验收当前 review 结果，绑定具体 Run 与结果版本；必需输出须完整。
- `work.retryAcceptance {workId,runId,expectedVersion,idempotencyKey?}`：用户对当前待验收结果重新获取预验收意见，返回更新后的 Work。Host 复用已在数据库保存的 Run、检查与产物；需正常完成、当前意见为服务故障且证据齐全。单 Host 同一个 Run 同时受理一项重试。提交时重查 Work 版本、Run 身份及结果版本。原意见保留在 Run.initialReview，并在审计事件中记录每次新旧意见。Work 保持待验收，验收与返工分别走原命令。

检查为 `{kind:'file',path,contains?}` 或 `{kind:'command',command,args:[],expectedExit:0}`。checksConsent 保存 `{checksRevision,checks,checksHash,actor,at}`；modelConsent 保存 `{modelRevision,model,actor,at}`。Host 执行命令检查前核验用户来源、修订及完整定义。

检查修改后，work.confirm 可同时确认当前修订并重新授权自动验收；work.authorize/use.authorize 可为当前版本重新授权。approveModel/approveChecks 分别确认模型和检查，自动验收另需当前工作授权。重新授权后，命令检查仍需精确检查同意。

同 session 的非终结 Work 互斥，accepted/cancelled/failed 释放占用；返工重新核验占用，冲突为 SESSION_BUSY。Host 核原生会话项目归属和 idle 状态。

## 调度与结果版本

- `readyWork(limit=20)`：每项目最多一项，要求 active 项目、queued Work、模型同意、关卡放行、依赖全部 accepted 及具名输入可解析。
- `reserveRun(workId)`：同一判定下原子预留；已有活动 Run 返回原对象，同项目其他活动执行为 WORKSPACE_BUSY。不同项目可并行。
- Run.inputs 保存解析后的值；consumedResults 保存 `{inputName,workId,runId,resultVersion,output,path,value}`。首次执行与实际返工在事务内核验上游验收与输出，缺失输出/路径为 NOT_READY；保留远端操作的恢复沿用上一 Run 的实际输入和消费版本。readyWork 与 reserveRun 共用输入选择逻辑，依赖验收、模型同意及人工关卡继续参与调度判定。
- prompt 保存本次工作、项目知识、定义知识快照、依赖/关卡快照、检查、输入与来源版本，给出 operationId=work.id、输出声明和 loom_report 用法。
- `markRunAccepted(runId,cursor)` 保存原生入箱事实。`updateRun(runId,patch)` 支持 cursor/status/running/diagnostic/observation/pendingInput/nativeFault/deliveryAttempts；`pendingInput` 是采样得到的原生 `approval`、`question`、`other` 类型数组。显式状态仅 dispatching/running，终态由专用接口收口。
- `recoverableRuns()` 返回 dispatching/accepted/running/pause_requested/cancel_requested。这些状态持有项目执行锁；外部等待释放锁。

游标是最后消费事件序号，初始 -1，须为大于等于 -1 的安全整数。更新取最大值，旧游标 observation 保持较新快照。Host 按 source.rpcId===run.requestId 核事件归属。Run 的 accepted 表示入箱，Work 的 accepted 表示验收。

`finishRun(runId,{reason,summary,eventCursor,checks=[],review=null,reportCallId?})` 保存终态。completed 对应 Work.review，其他原生原因原样保存并转 failed。同内容重放幂等，不同内容为 CONFLICT。

指定 reportCallId 时采纳当前 result 候选的 summary/outputs。Run.outputs 与 Work.result.outputs 一致，Run.resultVersion 等于 Work.result.version。无报告路径支持无输出声明工作；必需输出缺席时 verificationPassed=false，人工验收为 MISSING_OUTPUT。

review 为 `{passed,summary,source,evidence}`。检查结果须含布尔 passed，推荐 `{check:原定义,passed,...实际证据}`；绝对解析路径可另存。自动验收同时要求正常完成、具体 Work 当前用户授权、完整输出、review 通过且有证据、全部检查匹配通过、命令检查同意匹配 Run 快照。验收记录保存授权快照；撤回授权影响尚未完成的执行。

## 报告、等待与唤醒

```js
report = {kind:'result', summary, outputs:{name:JsonValue}}
       | {kind:'wait', summary, wait:{operationId,remoteRef,condition,nextCheckAt,checkMethod?}}
       | {kind:'uncertain', summary, uncertainty:{operationId,remoteRef,reason}}
       | {kind:'help', summary, help:{missingInformation,attempted,expectedEvidence}};
source = {sessionId,requestId,turn,step,callId};
```

- `getActiveRunForSession(sessionId)` 返回活动 Run 或 null。
- `reportRun(runId,report,source)` 核 Run/session/requestId 及可提交状态，按 callId 保存候选。Run.reports 固定为 `[{report,source}]`，每个新/迁移 Run 初始化 []。同 callId 同内容重放，冲突为 CONFLICT；每 Run 最多 20 候选。
- 报告根与嵌套拒绝执行身份及授权字段，如 actor/workId/runId/sessionId/requestId/authorization/modelConsent/checksConsent/permissionPreset/autoAccept。输出须有声明，业务 model 输出作为 JSON 数据保存。
- operationId 固定为 Work.id，远端引用/条件/原因须为非空文字。nextCheckAt 须是带时区有效日期，在报告时位于未来 30 天以内。
- `settleReport(runId,{callId,eventCursor,coordinate})`：wait 或带 `uncertainty.followUp:{checkMethod,nextCheckAt}` 的回执定时等待；正式 Host 同时把无复查时间的 uncertain 交给总控立即协调。`attempted` 与 `missingInformation` 成对记录运行者核过的来源及缺口。总控确认确实缺信息后，待补信息使用 `work.resume {workId,expectedVersion,information}` 继续原操作。
- `help` 用于缺少关键事实。`wait.source` 记录原 Run、session、工具步骤与轮次结束游标。`wait.originalOperation` 保存最初远端检查条件和用户补充，`wait.supplements` 保存后续补充；续办提示一并携带。
- 宿主按项目以 `nextExternalWait(at,workspaceId)` 选到期工作，使用 `claimExternalWait` 保留认领版本与复查退避时间，再通知该项目的后台协调会话。`work.resolveWait` 验证协调会话、工作版本和操作 ID；可保存交接线索并排回队列、安排下次检查，或登记具体待补信息。下一 Run 采用同一 Work/session/operationId、原 inputs/consumedResults，并携带已查来源及线索。暂停、取消或改版会使未完成的协调决定过期。

核心保存候选。Host 核同归属 turn 正常结束、对应原生 tool/result 成功、会话 idle 且活动归零，再调用 finishRun/settleReport。Host 负责失败回执诊断、恢复成功事实重建及原生工具终结保护。取消 waiting 结束本地跟踪，保留远端引用供展示及对账。

## 返工影响

`previewRework(workId)` 或 `query({kind:'rework',workId})` 返回 `{workId,version,affected:[{workId,version,status,consumedResults}],impactToken}`。

影响由当前有效 Run 的消费记录及其传递消费者计算，包含外部等待唤醒后排队的消费者。首次排队的工作尚未消费上游结果。`work.rework {workId,feedback,expectedVersion?,impactToken?,rerunWorkIds?}` 在存在影响时要求用户确认当前 impactToken 和重跑范围。过期为 CONFLICT；活动消费者先完成停止对账，否则 ACTIVE_CONSUMER。

返工目标和所选消费者清当前结果及 wait 后排队，沿用原 Work/session/定义及有效授权；新 Run 解析当前上游结果，旧 Run 保留输出、输入版本和远端引用。其余消费者保留结果及远端操作并追加 inputChanges，恢复时继续使用原输入。尚未开始的消费者在上游再次验收后绑定新版本。反馈、影响标记及状态变更同事务保存。

## 查询、分类及分页

`getWork/getWorkflow/getRun/getUse(id)` 返回对象或 null。`getWorkForSession(sessionId)` 优先返回非终结工作，否则返回最新历史工作。`getSettings()` 返回 `{version,roleModels,context,permissionPreset}`，角色包含 bus/review/worker/acceptance，review 缺省沿用 bus。

`query({kind,workspaceId?,workflowId?,workId?,useId?,legacy?,status?,categories?,after?,limit=50})` 返回 `{items,nextCursor,total}`。kind 支持 work/workflow/use/run/event/intent/workspace/control。每页上限 200；游标绑定过滤条件及第一页最大序号。新增记录在刷新时可见，状态变化会影响该序号范围的后续页和 total。

workflow 查询 legacy 默认 false，true 查询历史来源，'all' 查询全部。useId 筛选具体工作、Run、事件或指定 use。getUse/use 查询附 `progress:{total,completed,interaction,pending}`，由具体工作分类计算。

categories 仅用于 work，取 pending/completed/interaction 数组，多选取并集，与其他条件取交集；空数组返回空页。集合按固定顺序去重绑定游标，重排和重复保持等价。

| 分类 | 持久事实 |
| --- | --- |
| completed | accepted/cancelled |
| interaction | 待核对执行、待放行且上游已验收、活动 Run 待原生交互、待验收、失败及暂停 |
| pending | 其余，包括依赖等待、外部等待、排队、执行及停止收尾 |

分类 SQL 同时用于分页/计数及 use 进度。work 查询传 `includeDecision:true` 时，额外返回与 `items` 同序的 `decisions` 数组（无动作时为 null）。活动 Run 优先使用 `pendingInput`；未保存此字段的旧记录兼容诊断前缀。总览的待澄清请求以 `kind:intent,status:pending` 独立查询。Host snapshot 组合当前项目有界 use 页；总控详情分页及 queryMaxBytes 由 Host/上下文层管理。

## 持久控制回执

`pendingControls()` 返回 pending 控制。steer/pause/cancel 保存独立 requestId、Run/session 归属、actor 和 attempts。`ackSteer(controlId,{accepted,detail?})` 记录送达；拒收保持 pending，接收转 acknowledged，Work/Run 保持原状态。

`ackControl(controlId,{stopped,detail?})` 仅用于 pause/cancel。false 保存诊断并保留锁，true 将 Run/Work 收口为 paused/cancelled。`supersedeControl(controlId,detail?)` 终止过期控制，重复及迟到回执保持首次终态。暂停/取消替代待送达 steer；取消同时替代未完成暂停。

## SQLite 迁移

首次新版打开在单事务内升级为 PRAGMA user_version=1，重复打开幂等。部署前保存一致性备份。

- 有步骤旧 Workflow 保留 ID/version，转为 available 定义；完整旧对象保存为 legacySource。
- 每个旧 Workflow 生成确定性 `legacy:<workflowId>` use，包含全部关联 Work（含阶段外手建工作），保留阶段映射。
- 空步骤来源为只读 legacy，知识保留在历史 use/source 范围，项目知识保持原值。
- Work/Run/session/request/prompt/控制/事件/同意和验收证据保持。旧 Workflow 授权复制到历史 Work；新使用另行确认。
- 历史 Work 权限优先采用已有 Run 快照，显式 null 保持；缺少字段时使用迁移时设置。后续运行采用迁移时定义说明/知识快照。
- 当前 Work.result 对应的 Run 补 resultVersion 和实际已有 outputs，缺失输出证据保持缺席。
- commands 的原请求指纹及响应保持。结构引用错误报告确切对象/目标并整体回滚。

## 状态与错误

Work：awaiting_model/queued/dispatching/running/waiting/pause_requested/paused/cancel_requested/cancelled/review/accepted/failed。
Run：dispatching/accepted/running/waiting/uncertain/pause_requested/cancel_requested/completed/failed/paused/cancelled。

错误代码包括 INVALID_INPUT/NOT_FOUND/UNKNOWN_COMMAND/CONFLICT/FORBIDDEN/WORKSPACE_REQUIRED/WORKSPACE_MISMATCH/INVALID_DEPENDENCY/DEPENDENCY_CYCLE/INVALID_STATE/NOT_READY/WORKSPACE_BUSY/SESSION_BUSY/INVALID_CURSOR/MISSING_OUTPUT/ACTIVE_CONSUMER/MIGRATION_REQUIRED/MIGRATION_REFERENCE/MIGRATION_VERSION。意外内部错误向调用方传播。
