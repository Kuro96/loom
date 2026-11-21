// A binding's origin, not its stored value, determines whether the reader can act on it.
const labels = new Map(Object.entries({ source: '来源材料', materials: '本次材料', material: '本次材料', file: '输入文件', files: '输入文件', destination: '保存位置' }));
const controls = new Set(['dropreceipt', 'downloadfailures', 'processnow', 'operationid', 'remoteref', 'frontmatter']);
function isControl(name = '') {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_.-]+/);
  return controls.has(words.join('')) || /^(?:sha(?:1|256|512)?|md5|checksum|digest|bytes)$/.test(words.at(-1));
}
export function readerField(name, ref, param) {
  const caption = param?.description && param.description !== param.name && param.description !== name ? param.description : '';
  const label = caption || labels.get(name) || labels.get(param?.name) || name;
  // Do not silently demote a custom business input just because its name is English.
  const secondary = ref?.kind === 'output' || ref?.kind === 'result' || isControl(name) || isControl(param?.name) || (!caption && name === 'limit');
  return { label, secondary };
}
export function splitRequirements(description = '') {
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(description);
  if (header?.index === 0 && /^[\w\p{L}-]+\s*:/mu.test(header[1])) return { requirements: description.slice(header[0].length).trim(), metadata: header[1].trim() };
  return { requirements: description };
}
export function parameterFor(definition, binding) {
  return binding?.kind === 'parameter' ? definition?.parameters?.find(item => item.name === binding.path[0]) : null;
}
export const reviewLabel = (count = 1) => count === 1 ? '核对本次工作' : `核对本次 ${count} 项工作`;
export const batchActionLabel = (action, count) => count === 1 ? `${action}工作` : `${action}本次 ${count} 项工作`;
