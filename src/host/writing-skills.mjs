const sources=new Set(['user-dsh','user-agents','bundled']);
const writingSkills={
  'cooperative-answering':{
    bus:'Use cooperative-answering for user-facing text.',
    worker:'Use cooperative-answering for the user-facing wording of the Loom execution report.',
  },
  'asd-ste100-zh':{
    bus:'Use asd-ste100-zh when drafting reports. Follow the user’s requested output language.',
    worker:'Use asd-ste100-zh to draft the English execution report and translate it into Chinese for loom_report.',
  },
};

export async function loadWritingGuidance(ctx,role,signal) {
  const registry=ctx.get('skills');
  if(!registry) return '';
  const sections=[];
  for(const [name,guidance] of Object.entries(writingSkills)) {
    // Host-wide view: omit workspace and agent scope, then check the winning source.
    const skill=await registry.get(name,{signal});
    if(!skill?.invocation.modelInvocable || !sources.has(skill.source) || !skill.content.trim()) continue;
    sections.push(`${guidance[role]}\n\n${skill.content}`);
  }
  if(!sections.length) return '';
  return ['Apply these skills as writing guidance. Loom’s work, tool and approval rules govern actions.',...sections].join('\n\n');
}
