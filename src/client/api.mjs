import { unwrapResult } from './state.mjs';

export function createLoomApi(call) {
  const rpc = async (endpoint, payload = {}) => unwrapResult(await call('/api', `loom/${endpoint}`, payload));
  async function readEntity(kind, id) {
    const key = { work: 'workId', workflow: 'workflowId', use: 'useId' }[kind];
    const page = await rpc('query', { kind, [key]: id, limit: 1, ...(kind === 'workflow' ? { legacy: 'all' } : {}) });
    const value = page.items.find(item => item.id === id);
    if (!value) throw Object.assign(new Error(`${kind} 记录 ${id} 读取失败，请刷新工作台。`), { code: 'NOT_FOUND' });
    return value;
  }
  return { rpc, readWork: id => readEntity('work', id), readWorkflow: id => readEntity('workflow', id), readUse: id => readEntity('use', id) };
}
