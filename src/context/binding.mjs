const key=Symbol.for('dsh-loom.contextBindings.v1');
export const bindings=globalThis[key] ??= new WeakMap();
export function guardAgent(agent) {
  let binding=bindings.get(agent);
  if(binding) return binding;
  binding={owner:null,plugin:null,active:false};
  bindings.set(agent,binding);
  agent.ctx.on('agent/pre-step',(_step,next)=>{
    if(!binding.active) throw Object.assign(new Error('Loom binding is closed'),{code:'LOOM_BINDING_CLOSED'});
    return next();
  },{prepend:true});
  return binding;
}
