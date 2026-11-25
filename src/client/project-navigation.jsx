import { useId, useLayoutEffect, useRef, useState } from 'react';

export const projectName = (projects, id) => projects.find(project => project.workspaceId === id)?.title ?? '历史项目';

export function groupWorkflows(workflows, projects) {
  const groups = new Map();
  for (const flow of workflows) {
    const id = flow.workspaceId;
    if (!groups.has(id)) groups.set(id, { id, label: projectLabel(projects, id), workflows: [] });
    groups.get(id).workflows.push(flow);
  }
  return [...groups.values()];
}

function projectLabel(projects, id) {
  const project = projects.find(item => item.workspaceId === id);
  if (!project) return projectName(projects, id);
  return projects.some(item => item.workspaceId !== id && item.title === project.title)
    ? `${project.title} · ${project.path}` : project.title;
}

export function ProjectNavigation({ projects, workspaceId, onChange, children }) {
  const [expanded, setExpanded] = useState(false), [query, setQuery] = useState('');
  const anchor = useRef(null), search = useRef(null), pickerId = useId();
  const title = workspaceId ? projectName(projects, workspaceId) : '项目';
  const needle = query.trim().toLocaleLowerCase();
  const matches = projects.filter(project => `${project.title} ${project.path}`.toLocaleLowerCase().includes(needle));

  useLayoutEffect(() => { if (expanded) search.current?.focus(); }, [expanded]);
  function close(restoreFocus = false) {
    setExpanded(false); setQuery('');
    if (restoreFocus) anchor.current?.focus();
  }
  function choose(id, restoreFocus) {
    close(restoreFocus);
    if (id !== workspaceId) onChange(id);
  }

  return <nav className="loom-project-nav" aria-label="项目范围" onBlur={event => {
    if (expanded && !event.currentTarget.contains(event.relatedTarget)) close();
  }} onKeyDown={event => {
    if (expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }}>
    <button type="button" aria-current={!workspaceId ? 'page' : undefined} onClick={() => choose('', false)}>总览</button>
    <button type="button" ref={anchor} className="loom-project-trigger" title={title} aria-label={workspaceId ? `选择项目：${title}` : '选择项目'}
      aria-current={workspaceId ? 'page' : undefined} aria-expanded={expanded} aria-controls={expanded ? pickerId : undefined}
      onClick={() => expanded ? close() : setExpanded(true)}><span>{title}</span><span aria-hidden="true">▾</span></button>
    {children}
    {expanded && <div className="loom-project-picker" id={pickerId}>
      <input ref={search} aria-label="搜索项目" type="search" placeholder="搜索项目" value={query} onChange={event => setQuery(event.target.value)} />
      <ul className="loom-project-options">{matches.map(project => <li key={project.workspaceId}>
        <button type="button" aria-current={project.workspaceId === workspaceId ? 'page' : undefined}
          onClick={() => choose(project.workspaceId, true)}>{projectLabel(projects, project.workspaceId)}</button>
      </li>)}</ul>
      {!matches.length && <p role="status">{projects.length ? '没有匹配的项目' : '暂无可用项目'}</p>}
    </div>}
  </nav>;
}