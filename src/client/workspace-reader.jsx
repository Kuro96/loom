import { useEffect, useState } from 'react';
import { createBasicHtmlDocument } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/src/client/html/basic-document.ts';
import { ErrorNotice, InlinePage } from './components.jsx';

import { DocumentView } from './document-views.jsx';

function OriginalFile({ target, readFile, retry }) {
  const [prepare, setPrepare] = useState(false), [url, setUrl] = useState(null), [error, setError] = useState(null);
  useEffect(() => {
    if (!prepare) return;
    const controller = new AbortController(), { signal } = controller;
    let objectUrl;
    async function load() {
      const { data, eof } = await readFile(target, 'bytes', signal);
      if (signal.aborted) return;
      if (!eof) throw new Error('文件读取不完整。');
      objectUrl = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
      setUrl(objectUrl);
    }
    load().catch(reason => { if (!signal.aborted) setError(reason); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [prepare, readFile, target]);
  return <><p>此文件暂不支持预览，可在项目中打开原文件：</p><p className="loom-description"><code>{target.path}</code></p>
    {error ? <ErrorNotice error={error} onRetry={retry} /> : url ? <a href={url} download={target.path.split(/[/\\]/).pop()}>保存原文件</a> :
      <button type="button" disabled={prepare} onClick={() => setPrepare(true)}>{prepare ? '正在读取…' : '准备下载'}</button>}</>;
}

function FileContent({ target, readFile, retry, ...viewProps }) {
  const [page, setPage] = useState(null), [offset, setOffset] = useState(1), [error, setError] = useState(null);
  useEffect(() => {
    const controller = new AbortController(), { signal } = controller;
    async function load() {
      const next = await readFile(target, { offset }, signal);
      if (signal.aborted) return;
      if (next.offset !== offset || (!next.eof && next.lines < 1)) throw new Error('文件页不完整，请重新读取。');
      setPage(previous => {
        if (offset === 1) return { ...next, pages:[next] };
        if (previous.version !== next.version) return { changed: true };
        return { ...next, pages:[...previous.pages,next], text: previous.text + (next.lines ? '\n' : '') + next.text };
      });
    }
    load().catch(reason => { if (!signal.aborted) setError(reason); });
    return () => controller.abort();
  }, [target, offset, readFile]);
  if (page?.changed) return <p role="alert">文件已更新。 <button type="button" onClick={retry}>重新读取</button></p>;
  const unsupported = ['workspace-file/not-text', 'workspace-file/too-large'].includes(error?.code);
  return <>
    {page && (page.lines === 0 && !page.text ? <p>（空文件）</p> : <DocumentView target={target} {...viewProps} content={{kind:'text',text:page.text,pages:page.pages,eof:page.eof}} />)}
    {unsupported ? <OriginalFile target={target} readFile={readFile} retry={retry} /> : error ? <ErrorNotice error={error} onRetry={retry} /> : !page || page.offset !== offset ? <p role="status">正在读取…</p> :
      !page.eof && <button type="button" onClick={() => setOffset(page.offset + page.lines)}>继续阅读</button>}
  </>;
}

function BinaryContent({ target, readFile, retry, kind, ...viewProps }) {
  const [file, setFile] = useState(null), [error, setError] = useState(null);
  useEffect(() => {
    const c = new AbortController();
    async function load() {
      const file = await readFile(target, kind === 'office' ? 'office' : 'bytes', c.signal);
      if (c.signal.aborted) return;
      if (!file.eof) throw new Error('文件读取不完整。');
      setFile(kind === 'html' ? {...file,html:createBasicHtmlDocument(file.data)} : file);
    }
    load().catch(e => { if (!c.signal.aborted) setError(e); });
    return () => c.abort();
  }, [target, kind, readFile]);
  if (error) return <><ErrorNotice error={error} onRetry={retry} /><OriginalFile target={target} readFile={readFile} retry={retry} /></>;
  if (!file) return <p role="status">正在读取…</p>;
  return <><div className="loom-native-document"><DocumentView target={target} kind={kind === 'office' ? 'pdf' : kind} {...viewProps} content={{kind:'bytes',data:file.data,html:file.html}} /></div>
    {file.missingFonts?.length > 0 && <small>替代字体：{file.missingFonts.join('、')}</small>}</>;
}

function ReaderBody({ request, api, readFile, retry, views, useContextMenu }) {
  const [selection] = useState(request); // The keyed body owns one selection for its lifetime.
  const [target, setTarget] = useState(null), [error, setError] = useState(null);
  useEffect(() => {
    let current = true;
    api.rpc('preview', selection).then(value => { if (current) setTarget(value); }, reason => { if (current) setError(reason); });
    return () => { current = false; };
  }, [selection, api]);
  if (error) return <ErrorNotice error={error} onRetry={retry} />;
  if (!target) return <p role="status">正在读取…</p>;
  const kind = views.kind(target.path);
  const Content = ['markdown','text','code'].includes(kind) ? FileContent : BinaryContent;
  return <div className="loom-document" data-kind={kind}><Content target={target} readFile={readFile} retry={retry} views={views} kind={kind} useContextMenu={useContextMenu} /></div>;
}

export function WorkspaceReader({ request, title, api, readFile, views, useContextMenu, onClose }) {
  const [attempt, setAttempt] = useState(0);
  return <InlinePage title={title} onBack={onClose} reader>
    <ReaderBody key={JSON.stringify([request, attempt])} request={request} api={api} readFile={readFile} views={views} useContextMenu={useContextMenu} retry={() => setAttempt(n => n + 1)} />
  </InlinePage>;
}