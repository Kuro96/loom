import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path';
import { CodeBody } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/code/CodeBody.tsx';
import { TextBody } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/text/TextBody.tsx';
import { ImageBody } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/image/ImageBody.tsx';
import { ZoomViewport, zoomSurfaceClass } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/zoom/ZoomViewport.tsx';
import { excelFormat } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/excel/format.ts';
import { EXCEL_DEFAULTS } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/defaults.ts';


const namespaces = {markdown:'documentMarkdown', code:'sidebarCodePreview', image:'sidebarImage', pdf:'sidebarPdf', excel:'sidebarExcel', html:'documentHtml'};
const builtin = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/';
const loading = <p role="status">正在读取…</p>;

// The host loader resolves asynchronous assets relative to the owning client bundle.
export function documentViews(ctx, load = file => require.async(file)) {
  const lazyBody = (file, name) => lazy(async () => ({ default:(await load(file))[name] }));
  return {
    kind(path) {
      for (const {id} of ctx.documentPreviews.candidates(path)) {
        if (id.startsWith(builtin)) { const kind = id.slice(builtin.length); if (kind === 'office' || Object.hasOwn(namespaces, kind)) return kind; }
      }
      return 'text';
    },
    pdf:lazyBody('./client.pdf.js','PdfBody'), excel:lazyBody('./client.excel.js','ExcelBody'),
    limits:EXCEL_DEFAULTS,
    t:kind => ctx.locale.bind(namespaces[kind]), fileDrag:ctx.fileDrag.actions,
  };
}
const noop = () => {};

// The work dialog owns one document occurrence, including its page, zoom and lifetime.
export function DocumentView({ target, kind, content, views, useContextMenu }) {
  const [view, setView] = useState(undefined);
  const address = useMemo(() => sessionFileAddress(target.sessionId, target.path), [target]);
  const [life, setLife] = useState(null);
  useEffect(() => {
    const owner = new AbortController(); setLife(owner);
    return () => owner.abort();
  }, [target]);
  const actions = useMemo(() => ({
    page(_id, page) { setView(v => v?.page === page ? v : {...v, page}); },
    zoom(_id, zoom) { setView(v => kind === 'image' ? zoom : {...v, page:v?.page ?? 1, zoom}); },
  }), [kind]);

  if (!life) return loading;
  const common = {content, resourceAddress:address, sessionId:target.sessionId, wrap:true, scrollportRef:noop,
    useTabInfo:() => ({tab:{id:address, signal:life.signal, navigation:{}}}), useStore:selector => selector({byTab:{[address]:view}}),
    retainTab:noop, actions, useContextMenu, fileDrag:views.fileDrag};
  if (kind === 'text') return <TextBody {...common} />;
  const t = views.t(kind);
  if (kind === 'markdown') return <article><MarkdownText text={content.text} streaming={!content.eof} labels={{
    code:{copyLabel:t('code.copy'),copiedLabel:t('code.copied'),toolbarLabels:{codeLabel:t('codeBlock.title'),wrapLabel:t('codeBlock.wrap'),unwrapLabel:t('codeBlock.unwrap')}},footnotes:t('footnotes')}} /></article>;
  if (kind === 'code') return <CodeBody {...common} t={t} />;
  if (kind === 'html') return <iframe className="loom-html-document" title={t('frame')} sandbox="" referrerPolicy="no-referrer" srcDoc={content.html} />;
  if (kind === 'image') return <ImageBody {...common} t={t} />;
  const Body = views[kind];
  return <Suspense fallback={loading}><Body {...common} t={t} loading={loading} ZoomViewport={ZoomViewport} zoomSurfaceClass={zoomSurfaceClass}
    {...(kind === 'excel' ? {format:excelFormat(target.path),limits:views.limits} : {})} /></Suspense>;
}
