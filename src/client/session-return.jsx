import { useSyncExternalStore } from 'react';

// A return belongs to one visit, not to the session's durable history.
export function sessionNavigation(ctx) {
  let visit=null, visible=false;
  const listeners=new Set(), surface=ctx.sidebarRight.mounted;
  function sync() {
    const here=surface.getSnapshot(), shown=Boolean(visit && here===visit.id);
    if(visible && !shown) {
      if(ctx.layout.panelInfo.getSnapshot().activePanelId==='loom') nav.current=visit?.origin ?? nav.current;
      visit=null;
    }
    if(visible!==shown) {visible=shown; for(const fn of listeners) fn();}
  }
  const nav={current:null,
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    getSnapshot:()=>visible,
    open(id,origin) {
      visit={id,origin};
      try {ctx.uiWorkspace.openSession(id);sync();} catch(error){visit=null;sync();throw error;}
    },
    back(){if(!visible || !visit)return; nav.current=visit.origin;ctx.layout.selectPanel('loom');},
  };
  ctx.effect(()=>surface.subscribe(sync),'loom: session return');
  return nav;
}
export function SessionReturn({navigation}) {
  const shown=useSyncExternalStore(navigation.subscribe,navigation.getSnapshot);
  return shown ? <button type="button" className="loom-session-return" onClick={navigation.back}><span aria-hidden="true">← </span>返回上一页</button> : null;
}
