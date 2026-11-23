import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

// A return belongs to one visit, not to the session's durable history.
export function sessionNavigation(ctx) {
  const {layout, uiWorkspace, uiSession}=ctx;
  const main=uiSession.adapter.current, panels=layout.panelInfo;
  const listeners=new Set();
  let visit=null, snapshot=null;

  function publish(value) {
    if(snapshot===value)return;
    snapshot=value;
    for(const notify of listeners)notify();
  }
  function end() {
    if(!visit)return;
    visit.signal.removeEventListener('abort',end);
    visit=null;
    publish(null);
  }
  function sync() {
    if(!visit)return;
    if(panels.getSnapshot().activePanelId===null && main.getSnapshot().key===visit.id)publish(visit);
    else if(snapshot)end();
  }
  const nav={current:null,
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    getSnapshot:()=>snapshot,
    open(id,origin) {
      if(panels.getSnapshot().activePanelId!=='loom')return false;
      uiWorkspace.openSession(id);
      // Native open selects the panel synchronously; its scoped binding can arrive later.
      // The next native navigation aborts this visit even when it reopens the same ID.
      const signal=layout.beginNavigation();
      visit={id,origin,signal};
      signal.addEventListener('abort',end,{once:true});
      sync();
      return true;
    },
    back(from) {
      if(!from || snapshot!==from)return;
      nav.current=from.origin;
      try {layout.selectPanel('loom');}
      finally {
        if(panels.getSnapshot().activePanelId!=='loom')nav.current=null;
      }
    },
  };
  ctx.effect(()=>{
    const stopMain=main.subscribe(sync), stopPanel=panels.subscribe(sync);
    return ()=>{stopMain();stopPanel();end();};
  },'loom: session return');
  return nav;
}
export function SessionReturn({navigation}) {
  const visit=useSyncExternalStore(navigation.subscribe,navigation.getSnapshot);
  return visit ? <HeaderReturn visit={visit} navigation={navigation} /> : null;
}

function HeaderReturn({visit,navigation}) {
  const [anchor,setAnchor]=useState(null);
  useLayoutEffect(()=>{
    // The resident leading area is shared by blank and titled headers.
    // Portal beside its native controls so its single slot retains its occupant.
    let leading=null;
    const sync=()=>{
      if(leading?.isConnected)return;
      const next=document.querySelector('[data-conversation-header-leading]');
      if(leading!==next){leading=next;setAnchor(next);}
    };
    const observer=new window.MutationObserver(sync);
    observer.observe(document.body,{childList:true,subtree:true});
    sync();
    return ()=>observer.disconnect();
  },[]);
  return anchor && createPortal(<button type="button" className="loom-session-return" onClick={()=>navigation.back(visit)}><span aria-hidden="true">← </span>返回</button>,anchor);
}
