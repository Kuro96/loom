export function createCommandMemo() {
  let previousPayload, previousCommand;
  return payload => {
    const fingerprint = JSON.stringify(payload);
    if (fingerprint !== previousPayload) {
      previousPayload = fingerprint;
      previousCommand = { ...payload, idempotencyKey: crypto.randomUUID() };
    }
    return previousCommand;
  };
}

export function unwrapResult(result) {
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
}
export function errorText(error) {
  const label = `${error.code ? `${error.code}: ` : ''}${error.message ?? String(error)}`;
  return `${label}${error.code === 'CONFLICT' ? '。请刷新并重新查看当前版本后重试。' : ''}${error.details ? `\n${JSON.stringify(error.details, null, 2)}` : ''}`;
}

export const STATUS_LABELS = {
  needs_release: '待放行', needs_response: '待回应',
  proposed: '待确认', awaiting_model: '待确认', queued: '排队中', dispatching: '准备执行', running: '执行中', waiting: '等待中',
  pause_requested: '暂停中', paused: '已暂停', cancel_requested: '取消中', cancelled: '已取消',
  review: '待验收', accepted: '已验收', failed: '失败', draft: '草稿', active: '进行中', completed: '已完成',
};
export function statusLabel(status) { return STATUS_LABELS[status] ?? '状态暂不可用'; }
export function sessionLabel(session, index) {
  const title = session.title?.trim();
  return title && title !== session.sessionId ? title : `对话 ${index + 1}`;
}
export function resolvedModel(model, catalog) {
  if (!model || !catalog) return null;
  return catalogModels(catalog).find(option => option.key === modelKey(model) && option.available) ?? null;
}
export function modelLabel(model, catalog) {
  if (!model) return '尚未选择模型';
  const option = resolvedModel(model, catalog);
  if (!option) return '模型名称暂不可用';
  const effort = option.reasoning?.efforts?.find(item => item.id === model.reasoningEffort);
  return `${option.label}${effort?.name ? ` · ${effort.name}` : ''}`;
}
export function modelKey(model) { return model ? JSON.stringify([model.provider, model.model]) : ''; }
export function modelFromKey(key) {
  if (!key) return null;
  const [provider, model] = JSON.parse(key);
  return { provider, model };
}
export function catalogModels(catalog) {
  return catalog.groups.flatMap(group => group.models.map(model => ({
    key: modelKey({ provider: group.id, model: model.id }), provider: group.id, model: model.id,
    label: group.name?.trim() && model.name?.trim() ? `${group.name} / ${model.name}` : '模型名称暂不可用',
    available: Boolean(group.name?.trim() && model.name?.trim()), reasoning: model.reasoning,
  })));
}
export function switchModel(current, selected, catalog) {
  if (!selected) return null;
  if (modelKey(current) === modelKey(selected)) return { ...current, ...selected };
  const { reasoningEffort, ...previous } = current ?? {};
  const next = { ...previous, ...selected };
  const effort = selected.reasoningEffort ?? reasoningEffort;
  const option = catalog ? catalogModels(catalog).find(item => item.key === modelKey(selected)) : null;
  const compatible = catalog ? option?.reasoning?.efforts?.some(item => item.id === effort) : effort === selected.reasoningEffort;
  if (effort !== undefined && compatible) next.reasoningEffort = effort;
  else delete next.reasoningEffort;
  return next;
}
export function applyDefaultModel(models, value, catalog) {
  const previous = modelKey(models.bus);
  return Object.fromEntries(['bus', 'review', 'worker', 'acceptance'].map(role => {
    const current = models[role];
    if (role === 'bus') return [role, value];
    if (current && modelKey(current) !== previous) return [role, current];
    return [role, value ? switchModel(current, { provider: value.provider, model: value.model }, catalog) : null];
  }));
}

export async function saveSettings(execute, api, payload, expectedVersion, onReadback) {
  let failure;
  try { await execute({ type: 'settings.update', ...payload, expectedVersion }); }
  catch (reason) { failure = reason; }
  const confirmed = (await api.rpc('snapshot', {})).settings;
  onReadback(confirmed);
  if (failure) throw failure;
  for (const [field, expected] of Object.entries(payload)) {
    if (field === 'roleModels' || field === 'context') {
      for (const [key, value] of Object.entries(expected)) {
        const actual = confirmed[field][key];
        const resolved = field === 'roleModels' && key === 'review' && value === null ? confirmed.roleModels.bus : value;
        if (JSON.stringify(actual) !== JSON.stringify(resolved)) throw new Error('设置保存后读回不一致，已显示当前保存值。');
      }
    } else if (confirmed[field] !== expected) throw new Error('设置保存后读回不一致，已显示当前保存值。');
  }
  return confirmed;
}

export function needsBusConnection(bus, context) {
  return !bus?.sessionId || context?.status === 'unloaded';
}
export function transcriptText(entries) {
  let text = '';
  function append(value) { text += value.slice(0, 32768 - text.length); }
  function visit(value, depth) {
    if (text.length >= 32768) return;
    if (value === null || typeof value !== 'object') {
      append(typeof value === 'string' ? value.slice(0, 4096) : String(value));
    } else if (depth === 6) append('…');
    else {
      const keys = Object.keys(value);
      for (const key of keys.slice(0, 20)) {
        if (text.length >= 32768) break;
        append(`\n${key}: `); visit(value[key], depth + 1);
      }
      if (keys.length > 20) append('\n…');
    }
  }
  for (const { event } of entries.slice(-100)) {
    if (text.length >= 32768) break;
    append(`\n#${event.seq} ${event.type}\n`); visit(event.data, 0); append('\n');
  }
  return text;
}
export function transcriptMessages(entries) {
  const messages = [];
  let remaining = 32768;
  for (const { event } of entries.slice(-100).reverse()) {
    if (!remaining) break;
    const role = { 'user/message': '你', 'assistant/message': '助手', 'tool/result': '工具结果' }[event.type];
    if (!role) continue;
    const message = event.data.message ?? event.data;
    if (['loom-context', 'loom-evidence'].includes(message.source?.kind)) continue;
    const content = message.content ?? message.text;
    const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.slice(0, 20).map(part => {
      if (part.type === 'text' && typeof part.text === 'string') return part.text.slice(0, 4096);
      if (part.type === 'image') return '［图片］';
      if (part.type === 'tool-call') return '［工具调用］';
      return '';
    }) : [];
    const full = parts.join('\n');
    if (!full) continue;
    const limit = Math.min(4096, remaining);
    const text = full.length > limit ? `${full.slice(0, limit - 1)}…` : full;
    remaining -= text.length;
    messages.push({ id: event.seq, role, text });
  }
  return messages.reverse();
}
export function followBus(target, previous, next) {
  if (!next || !next.sessionId) return target;
  return !target || target === previous?.sessionId ? next.sessionId : target;
}

export function blockingReasons(work, works) {
  const reasons = [];
  if (!work.model) reasons.push('尚未选择执行模型');
  else if (!work.modelConsent || work.modelConsent.modelRevision !== work.modelRevision) reasons.push('等待用户确认当前模型');
  if (work.checks.some(check => check.kind === 'command') && (!work.checksConsent || work.checksConsent.checksRevision !== work.checksRevision)) reasons.push('命令检查等待用户授权');
  for (const id of work.dependsOn) {
    const dependency = works.find(item => item.id === id);
    if (!dependency) reasons.push('正在读取依赖状态…');
    else if (dependency.status !== 'accepted') reasons.push(`等待依赖：${dependency.title}（${statusLabel(dependency.status)}）`);
  }
  if (work.gate?.required && !work.gate.released) reasons.push('人工关卡等待放行');
  for (const field of ['blockedReason', 'blockReason', 'error']) {
    if (work[field]) reasons.push('执行遇到问题。');
  }
  if (work.status === 'queued' && reasons.length === 0) {
    const occupied = works.find(item => item.id !== work.id && item.workspaceId === work.workspaceId
      && ['dispatching', 'running', 'pause_requested', 'cancel_requested'].includes(item.status));
    reasons.push(occupied ? `等待「${occupied.title}」结束` : '等待开始执行');
  }
  return reasons;
}

export async function approveWork(shown, consent, command, readWork) {
  let current = shown;
  if (consent.checks) {
    await command({ type: 'work.approveChecks', workId: shown.id, expectedVersion: shown.version,
      ...(shown.checksRevision === undefined ? {} : { checksRevision: shown.checksRevision }) });
    current = await readWork(shown.id);
    if (current.modelRevision !== shown.modelRevision || JSON.stringify(current.model) !== JSON.stringify(shown.model)
      || current.checksRevision !== shown.checksRevision || JSON.stringify(current.checks) !== JSON.stringify(shown.checks)) {
      throw new Error('模型或检查在确认期间发生变化。请重新查看并确认。');
    }
  }
  if (consent.model) {
    await command({ type: 'work.approveModel', workId: shown.id, modelRevision: shown.modelRevision, expectedVersion: current.version });
  }
  return readWork(shown.id);
}

export function parseJSON(text, label) {
  try { return JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${label} JSON 格式错误：${error.message}`, { cause: error });
  }
}

export function validateChecks(checks) {
  if (!Array.isArray(checks)) throw new Error('checks 须为数组');
  for (const check of checks) {
    if (!check || typeof check !== 'object') throw new Error('每项检查须为对象');
    if (check.kind === 'file') {
      if (typeof check.path !== 'string' || !check.path.trim()) throw new Error('文件检查须填写 path');
      if (check.contains !== undefined && typeof check.contains !== 'string') throw new Error('contains 须为字符串');
    } else if (check.kind === 'command') {
      if (typeof check.command !== 'string' || !check.command.trim()) throw new Error('命令检查须填写 command');
      if (check.args !== undefined && (!Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string'))) throw new Error('命令 args 须为字符串数组');
      if (check.expectedExit !== undefined && check.expectedExit !== 0) throw new Error('expectedExit 须为 0');
    } else throw new Error(`未知检查类型：${check.kind}`);
  }
  return checks;
}

export function parseChecks(text) { return validateChecks(parseJSON(text, '检查')); }

export function parseStages(text) {
  const stages = parseJSON(text, '阶段');
  if (!Array.isArray(stages)) throw new Error('阶段须为数组');
  const index = new Map();
  for (const stage of stages) {
    if (!stage || typeof stage.id !== 'string' || !stage.id.trim() || typeof stage.title !== 'string' || !stage.title.trim()) throw new Error('每个阶段须填写 id 和 title');
    if (index.has(stage.id)) throw new Error(`阶段 ID 重复：${stage.id}`);
    if (stage.instructions !== undefined && typeof stage.instructions !== 'string') throw new Error('instructions 须为字符串');
    if (stage.manualGate !== undefined && typeof stage.manualGate !== 'boolean') throw new Error('manualGate 须为布尔值');
    if (stage.dependsOn !== undefined && (!Array.isArray(stage.dependsOn) || stage.dependsOn.some(id => typeof id !== 'string') || new Set(stage.dependsOn).size !== stage.dependsOn.length)) throw new Error('dependsOn 须为唯一 ID 数组');
    validateChecks(stage.checks ?? []);
    index.set(stage.id, stage);
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (!index.has(id)) throw new Error(`依赖阶段不存在：${id}`);
    if (visiting.has(id)) throw new Error(`阶段依赖存在环：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of index.get(id).dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of index.keys()) visit(id);
  return stages;
}

export function mergePage(previous, incoming) {
  const rows = new Map(previous.items.map(item => [item.id, item]));
  for (const item of incoming.items) rows.set(item.id, item);
  return { ...incoming, items: [...rows.values()] };
}
