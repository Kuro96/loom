/** Apply a managed-session preset through the native durable permission service. */
export function applyPermissionPreset(ctx,session,preset) {
  if(preset===null) return null;
  ctx.permissionPresets.set(session,preset);
  const current=ctx.permissionPresets.current(session);
  if(current!==preset) throw new Error(`执行权限设置读回不一致：期望 ${preset}，实际 ${current}`);
  return current;
}
