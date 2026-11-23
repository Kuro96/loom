import {useEffect,useId,useRef,useState} from 'react';
import {ErrorNotice,Json} from './components.jsx';

const number=new Intl.NumberFormat('en-US');
const clock=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const shortClock=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const status={completed:'完成',failed:'失败',stopped:'停止'};
const count=value=>value===null?'未报告':number.format(value);
const name=turn=>`第 ${turn.segment} 段 · 第 ${turn.turn} 轮`;
const modelName=({model,provider})=>`${model}（${provider}）`;
const date=(value,format=clock)=>format.format(value);

function useUsage(api,key) {
  const [state,setState]=useState({value:null,error:null});
  const [version,setVersion]=useState(0);
  useEffect(()=>{
    let active=true;
    setState({value:null,error:null});
    api.rpc('usage',key===undefined ? {} : {key}).then(value=>{
      if(active) setState({value,error:null});
    },error=>{if(active) setState({value:null,error});});
    return ()=>{active=false;};
  },[api,key,version]);
  const issue=state.value?.error;
  const historical=issue?.code==='LOOM_USAGE_LEGACY';
  return {...state,historicalCoverage:historical ? issue.message : null,issue:historical ? null : issue,
    retry:()=>setVersion(value=>value+1)};
}

function coverage(value,legacy=false) {
  if(!value.calls) return legacy?'历史覆盖不全 · 用量未报告':'无模型调用';
  if(!value.reported) return `未报告（${value.calls} 次调用）`;
  if(legacy || value.inputCount<value.calls || value.outputCount<value.calls) return `部分统计（已报告 ${value.reported}/${value.calls}）`;
  return `已报告 ${value.reported}/${value.calls}`;
}

function scale(values) {
  const maximum=Math.max(1,...values);
  const order=10**Math.floor(Math.log10(maximum));
  return Math.ceil(maximum/order)*order;
}

function Bar({value,max,fields}) {
  const known=fields.some(([field])=>value[field]!==null);
  return <span className="loom-usage-bar" aria-hidden="true">{known ? fields.map(([field,kind])=>value[field]>0 &&
    <span key={field} className={`loom-usage-${kind}`} style={{height:`${value[field]/max*100}%`}} />)
    : <span className="loom-usage-missing" />}</span>;
}
const inputFields=[['hit','hit'],['miss','miss'],['unknownSplit','unknown']];
const outputFields=[['output','output']];

function Chart({rows,selected,select}) {
  const order=[...rows].reverse();
  const input=scale(order.map(row=>row.main.input)),output=scale(order.map(row=>row.main.output));
  return <figure className="loom-usage-chart" aria-label="总控主对话逐轮用量">
    <figcaption>主对话 · 单位：token</figcaption>
    <div className="loom-usage-legend">{[['hit','缓存命中'],['miss','未命中'],['unknown','拆分未知'],['output','输出']].map(([key,label])=>
      <span key={key}><i className={`loom-usage-${key}`} aria-hidden="true" />{label}</span>)}</div>
    <div className="loom-usage-plot">
      <div className="loom-usage-axes" aria-hidden="true">
        <div><span><strong>输入</strong> {count(input)}</span><span>0</span></div>
        <div><span><strong>输出</strong> {count(output)}</span><span>0</span></div>
      </div>
      <div className="loom-usage-columns" style={{gridTemplateColumns:`repeat(${order.length},minmax(0,1fr))`}}>
        {order.map(turn=><button key={turn.key} type="button" className="loom-usage-column" aria-pressed={selected===turn.key}
          aria-label={`${name(turn)}，${date(turn.startedAt)}，输入 ${count(turn.main.input)}，输出 ${count(turn.main.output)}${turn.review.calls?'，有回顾':''}，${coverage(turn.main,turn.legacy)}`}
          onClick={()=>select(turn.key)}>
          <Bar value={turn.main} max={input} fields={inputFields} />
          <Bar value={turn.main} max={output} fields={outputFields} />
          <span aria-hidden="true" className={turn.review.calls?'loom-usage-review-dot':undefined} />
        </button>)}
      </div>
      <div className="loom-usage-time"><span>{date(order[0].startedAt,shortClock)}</span>{order.length>1 && <span>{date(order.at(-1).startedAt,shortClock)}</span>}</div>
    </div>
    {rows.some(turn=>turn.review.calls>0) && <p className="loom-hint">图下方圆点表示有回顾。</p>}
  </figure>;
}

function Metrics({value,peak=false,expanded=false}) {
  const fields=[['总输入',value.input],['缓存命中',value.hit],['未命中',value.miss],['输出',value.output]];
  if(value.unknownSplit!==null) fields.push(['拆分未知',value.unknownSplit]);
  if(peak) fields.push([value.inputCount<value.calls?'已知单次主请求输入峰值':'单次主请求输入峰值',value.peak]);
  if(expanded) fields.push(['缓存写入',value.write]);
  return <dl className="loom-usage-metrics">{fields.map(([label,n])=><div key={label}><dt>{label}</dt><dd>{count(n)}</dd></div>)}</dl>;
}

function ModelList({value}) {
  return value.models.length>0 && <p>{value.models.map(model=>`${modelName(model)} × ${model.calls}`).join('、')}</p>;
}

function CallDetails({api,turnKey,storageInSummary}) {
  const {value,error,issue,retry}=useUsage(api,turnKey);
  const repeatedStorage=storageInSummary && issue?.code==='LOOM_USAGE_STORAGE';
  return <>
    <ErrorNotice error={error ?? (repeatedStorage ? null : issue)} onRetry={retry} />
    {!value && !error && <p role="status">正在读取调用明细…</p>}
    {value?.calls.length>0 && <ol className="loom-usage-calls" aria-label="调用明细">{value.calls.map(call=><li key={call.callId}>
      <strong>第 {call.step} 步 · {call.purpose==='compaction'?'回顾':'主对话'} · {status[call.status]}</strong>
      <p>{modelName(call)} · 输入 {count(call.input)} · 输出 {count(call.output)} · 缓存写入 {count(call.write)}</p>
      <details><summary>适配器报告</summary><Json value={call.usage && {source:call.usageSource,layout:call.layout,...call.usage}} empty="用量未报告" /></details>
    </li>)}</ol>}
  </>;
}

function TurnRow({turn,expanded,toggle,api,register,storageInSummary}) {
  const detailsId=useId();
  return <li className="loom-usage-row">
    <button type="button" aria-expanded={expanded} aria-controls={detailsId} ref={register} onClick={toggle}>
      {name(turn)} · {status[turn.status]}{turn.review.calls>0 ? ' · 有回顾' : ''}
    </button>
    <p><time dateTime={new Date(turn.startedAt).toISOString()}>{date(turn.startedAt)}</time> · {turn.main.calls} 次主调用 · {coverage(turn.main,turn.legacy)}</p>
    {turn.legacy && <p className="loom-hint">历史补录 · 覆盖不全</p>}
    <ModelList value={turn.main} />
    <Metrics value={turn.main} peak expanded={expanded} />
    <div id={detailsId} hidden={!expanded}>{expanded && <>
      {turn.review.calls>0 && <>
        <h4>本轮回顾 · {turn.review.calls} 次 · {coverage(turn.review,turn.legacy)}</h4>
        <ModelList value={turn.review} /><Metrics value={turn.review} expanded />
        <h4>含回顾合计 · {coverage(turn.combined,turn.legacy)}</h4><Metrics value={turn.combined} expanded />
      </>}
      <CallDetails api={api} turnKey={turn.key} storageInSummary={storageInSummary} />
    </>}</div>
  </li>;
}

export function UsagePanel({api}) {
  const {value,error,historicalCoverage,issue,retry}=useUsage(api);
  const [selected,setSelected]=useState(null), controls=useRef(new Map());
  const heading=useId();
  function choose(key) {
    setSelected(key);
    const control=controls.current.get(key);
    if(control) {control.focus({preventScroll:true});control.scrollIntoView({block:'nearest'});}
  }
  return <section className="loom-settings-section loom-usage" aria-labelledby={heading}>
    <div className="loom-usage-heading"><h3 id={heading}>总控用量</h3><button type="button" onClick={retry}>刷新用量</button></div>
    {historicalCoverage && <p className="loom-hint" role="status">{historicalCoverage}</p>}
    <ErrorNotice error={error ?? issue} onRetry={retry} />
    {!value && !error && <p role="status">正在读取总控用量…</p>}
    {value?.items.length===0 && <p className="loom-hint">暂无已结束的总控轮次。</p>}
    {value?.items.length>0 && <>
      <Chart rows={value.items} selected={selected} select={choose} />
      <h4>最近 {value.items.length} 轮</h4>
      <ol className="loom-usage-list">{value.items.map(turn=><TurnRow key={turn.key} turn={turn} api={api} expanded={selected===turn.key} storageInSummary={issue?.code==='LOOM_USAGE_STORAGE'}
        toggle={()=>setSelected(key=>key===turn.key?null:turn.key)} register={node=>{if(node) controls.current.set(turn.key,node);else controls.current.delete(turn.key);}} />)}</ol>
    </>}
  </section>;
}
