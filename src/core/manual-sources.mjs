export const manualEvidenceLimit = 48 * 1024;
export const manualSelectionLimit = 12;
export const markdownName = name => typeof name === 'string' && /\.(?:md|markdown)$/i.test(name);
export const pickedName = name => markdownName(name) && name.length <= 255 && !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) && name.isWellFormed();
export const markdownBody = body => typeof body === 'string' && Boolean(body.trim()) && !body.includes('\u0000') && body.isWellFormed();
export const manualLines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export const manualApproval = text => /人工.{0,10}(?:放行|审批|批准|审核|确认|签字|签核)|(?:审批|审核|批准|签字|签核|放行|确认)(?:后|通过|才|方可)|(?:等待|须经|需经).{0,12}(?:审批|审核|批准|放行|确认)|\b(?:approval|sign[- ]?off)\b|\b(?:human|manual|operator|manager)\s+(?:review|confirmation|authorization)\b/i.test(text);
export const manualResourceStatus = { missing: '缺失', unverified: '尚未验证', read: '正文已读取 · 运行待验证', present: '文件存在 · 运行待验证' };

export function manualHandoffIssue(definition) {
  for (const stage of definition.stages) for (const input of Object.values(stage.inputs)) {
    if (input.kind !== 'output') continue;
    if (input.path.length) return `「${stage.title}」须接收整个输出；请清空字段路径，或将所需内容单独声明为必需输出。`;
    const source = definition.stages.find(item => item.id === input.stageId);
    const output = source && source.outputs.find(item => item.name === input.output);
    if (!output) return `请为「${stage.title}」选择有效的来源步骤和输出。`;
    if (!output.required) {
      return `请把「${stage.title}」使用的上游输出「${input.output}」标为必需。`;
    }
  }
  return '';
}