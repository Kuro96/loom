const categoryOrder = ['pending', 'completed', 'interaction'];
export const UNCLASSIFIED = '__unclassified';

function* pageRows(page, kind, category) {
  for (const [index, item] of page.items.entries()) {
    const { status, workspaceId, workflowId, createdAt } = item;
    const base = { category, status, workspaceId, workflowId, createdAt };
    if (kind === 'work') {
      yield { ...base, key: `work:${item.id}`, title: item.title, stageId: item.stageId, work: item, decision: page.decisions?.[index] };
    } else if (kind === 'intent') {
      yield { ...base, key: `intent:${item.id}`, title: item.text, intent: item };
    } else if (category === 'interaction') {
      yield { ...base, key: `proposal:${item.id}`, title: item.definitionSnapshot.title, proposal: item };
    } else {
      for (const stage of item.definitionSnapshot.stages) {
        yield { ...base, key: `proposal:${item.id}:${stage.id}`, title: stage.title, stageId: stage.id, proposal: item };
      }
    }
  }
}

// Count rendered decisions; ended proposals still show their ordinary stage rows.
async function readGroup(api, scope, category, depth, pageSize) {
  const sources = [{ kind: 'work', categories: [category] }];
  if (category === 'interaction') sources.unshift({ kind: 'use', status: 'proposed' });
  if (category === 'interaction' && !Object.keys(scope).length) sources.push({ kind: 'intent', status: 'pending' });
  if (category === 'completed') sources.push({ kind: 'use', status: 'cancelled' });
  const rows = [], capacity = depth * pageSize;
  for (const source of sources) {
    let after;
    do {
      const limit = Math.min(pageSize, Math.max(1, capacity - rows.length));
      const page = await api.rpc('query', { ...scope, ...source, limit, ...(source.kind === 'work' && category === 'interaction' ? { includeDecision: true } : {}), ...(after ? { after } : {}) });
      for (const row of pageRows(page, source.kind, category)) {
        if (rows.length === capacity) return { rows, hasMore: true };
        rows.push(row);
      }
      after = page.nextCursor;
      if (rows.length === capacity && after !== null) return { rows, hasMore: true };
    } while (after !== null);
  }
  return { rows, hasMore: false };
}

export async function readWorkList(api, { workspaceId, workflowId, categories = categoryOrder, depth = 1, pageSize = 25 } = {}) {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new RangeError('分页深度须为正整数');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new RangeError('分页条数须为 1 至 200');
  const scope = workspaceId ? { workspaceId } : {};
  if (workflowId !== undefined && workflowId !== '') scope.workflowId = workflowId === UNCLASSIFIED ? null : workflowId;
  const groups = await Promise.all(categoryOrder.filter(id => categories.includes(id))
    .map(category => readGroup(api, scope, category, depth, pageSize)));
  return { rows: groups.flatMap(group => group.rows), hasMore: groups.some(group => group.hasMore) };
}
