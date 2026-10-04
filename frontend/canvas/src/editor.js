import { clone, studioState, RUNTIME_KEYS, BATCH_KEY, mergeRuntime, outputOf } from './studio-schema.js';
import { uid, NODE_TYPES } from './store.js';

// 编辑历史只回退创作数据。任务、未确认提交和结果身份是单向事实，禁止撤销。
// clipboard 跨项目保留：同项目走同步 paste()（选区外上游继续引用原节点）；
// 跨项目用 pasteAcrossProject()/pasteIntoCurrent()——素材 blob 克隆新身份、导演台 KV 先读后写且
// xp-asset:// 令牌全量换绑、分镜引用重映射、付费运行时身份剥离、选区外上游按复制时快照物化为
// 素材/文本来源节点（缺失输出落成显式占位，下游提交被 runner.wired 显式阻止）；
// 提交后 await store.flush()：落盘失败回滚本次全部新增（节点/边/素材/分镜/KV/blob），不碰既有数据。
export function createEditor(store, storage) {
  let pid, undo=[], redo=[], runtime=new Map(), clipboard=null;
  function sync(){if(pid!==store.project?.id){pid=store.project?.id;undo=[];redo=[];runtime=new Map();/* clipboard 跨项目保留 */}}
  store.onChange?.(reason => { if (reason?.type === 'project') sync(); });
  // remember 必须同步删除已消失的键：否则运行时被清掉的字段会在撤销时被旧值复活
  function remember(){for(const n of store.project?.nodes??[]){const r=runtime.get(n.id)??{};for(const k of RUNTIME_KEYS){if(n.data[k]!==undefined)r[k]=clone(n.data[k]);else delete r[k];}runtime.set(n.id,r);}}
  function snapshot(){return clone({nodes:store.project.nodes,edges:store.project.edges,studio:studioState(store.project)});}
  function checkpoint(){sync();remember();undo.push(snapshot());if(undo.length>60)undo.shift();redo=[];}
  function restore(value){remember();mergeRuntime(value.nodes,runtime);const workflow=store.project.studio?.workflow;Object.assign(store.project,value);store.project.studio??={version:1,groups:[],shots:[],timeline:[],workflow:null};store.project.studio.workflow=workflow;store.touch({type:'structure'});}
  function travel(from,to){sync();if(!from.length)return false;to.push(snapshot());restore(from.pop());return true;}
  // 收集节点引用的素材 id 与分镜 id（params.*ShotId / params.shotId），供跨项目粘贴随附；
  // 节点 data 内嵌的 xp-asset://<id> 令牌（导演台 editorState 等）也一并收集。
  const XP_TOKEN_RE=/xp-asset:\/\/([A-Za-z0-9_-]+)/g;
  function scanXpTokens(value,out){let s;try{s=JSON.stringify(value);}catch{return;}if(typeof s!=='string'||!s.includes('xp-asset://'))return;for(const m of s.matchAll(XP_TOKEN_RE))out.add(m[1]);}
  function collectRefs(nodes){
    const assetIds=new Set(), shotIds=new Set();
    for(const n of nodes){
      const d=n.data??{};
      if(typeof d.assetId==='string')assetIds.add(d.assetId);
      for(const b of [d.bindings,d.draft?.bindings,...Object.values(d.perModel??{}).map(s=>s?.bindings)]){
        if(b&&typeof b==='object')for(const v of Object.values(b))if(typeof v==='string')assetIds.add(v);
      }
      const p=d.params;
      if(p&&typeof p==='object')for(const[k,v]of Object.entries(p))if(/shotid$/i.test(k)&&typeof v==='string')shotIds.add(v);
      scanXpTokens(d,assetIds);
    }
    return{assetIds,shotIds};
  }
  function copy(ids){
    sync();
    const selected=new Set(ids);
    const nodes=store.project.nodes.filter(n=>selected.has(n.id));
    // 保留指向选区外的上游连线：同项目粘贴继续引用原上游；跨项目粘贴用 upstream 快照物化来源。
    // 不复制下游、不继承任务/付费运行时身份。
    const edges=store.project.edges.filter(e=>selected.has(e.to.node));
    const{assetIds,shotIds}=collectRefs(nodes);
    const shots=(store.project.studio?.shots??[]).filter(s=>shotIds.has(s.id));
    // 分镜内引用的素材（assetIds / versions[].assetId / sync.assetId）随剪贴板快照——只带分镜不带素材会在目标项目悬空
    for(const s of shots){
      for(const x of s.assetIds??[])if(typeof x==='string')assetIds.add(x);
      for(const v of s.versions??[])if(typeof v?.assetId==='string')assetIds.add(v.assetId);
      if(typeof s.sync?.assetId==='string')assetIds.add(s.sync.assetId);
    }
    // 选区外上游的输出快照（复制时点）：跨项目粘贴据此物化来源节点，源项目之后的改动/切换不影响剪贴板
    const upstream={};
    for(const e of edges){
      if(selected.has(e.from.node)||upstream[e.from.node])continue;
      const src=store.project.nodes.find(n=>n.id===e.from.node);
      const out=outputOf(store.project,src);
      const spec={title:src?.data?.title||src?.type||'',text:out.text??'',assetIds:[]};
      for(const a of out.assets){
        if(!a||a.missing){spec.assetIds.push(null);continue;}   // 缺失占位保序：缺失上游照样显式物化，不丢线
        spec.assetIds.push(a.id);assetIds.add(a.id);
      }
      upstream[e.from.node]=spec;
    }
    const assets={};
    for(const aid of assetIds){const a=store.project.assets[aid];if(a)assets[aid]=clone(a);}
    clipboard=clone({pid,nodes,edges,assets,shots,upstream});
    return nodes.length;
  }
  function paste(offset={x:48,y:48}){
    sync();
    if(!clipboard?.nodes?.length||clipboard.pid!==pid)return[];
    checkpoint();
    const map=new Map();
    const nodes=clipboard.nodes.map(n=>{const c=clone(n);c.id=uid('n');map.set(n.id,c.id);c.x+=offset.x;c.y+=offset.y;for(const k of RUNTIME_KEYS)delete c.data[k];delete c.data[BATCH_KEY];c.data.locked=false;return c;});
    store.project.nodes.push(...nodes);
    for(const e of clipboard.edges){
      const from=map.get(e.from.node)??e.from.node;const to=map.get(e.to.node);
      if(!to||!store.node(from))continue;
      store.project.edges.push({...clone(e),id:uid('e'),from:{...e.from,node:from},to:{...e.to,node:to}});
    }
    store.touch({type:'structure'});
    return nodes;
  }
  // 跨项目粘贴：素材克隆独立身份（blob 内容复制到新键），分镜随附并重映射；
  // 导演台 KV 先读后写：重键 + xp-asset:// 令牌全量换绑，未登记引用落成显式 missing 占位；
  // 选区外上游按复制时快照物化为来源节点（素材/文本；缺失输出 → assetId=null+needsRebind 占位，
  // 下游提交被 runner.wired/validateDraft 显式阻止，绝不静默退化成无参考输入）。
  // 顺序：KV/blob 全部暂存 → 项目身份+修订号守卫 → 内存提交 → await flush；
  // 任何失败清理本次新建键并回滚内存，剪贴板与源数据绝不动；flush 成功后返回值含物化来源节点。
  async function pasteAcrossProject(offset={x:48,y:48}){
    sync();
    if(!clipboard?.nodes?.length)return[];
    if(clipboard.pid===pid)return paste(offset);
    if(!storage)throw new Error('跨项目粘贴需要存储接口：createEditor(store, storage)');
    const project=store.project;
    const assetMap=new Map(),newAssets={},stagedBlobs=[],writtenKV=[];
    const alive=()=>store.project===project;
    const cleanup=async()=>{   // 只清理本次新建的键；剪贴板与源 blob/KV 绝不动
      for(const k of writtenKV){try{await storage.del(k)}catch{/* 尽力 */}}
      for(const k of stagedBlobs){try{await storage.delBlob(k)}catch{/* 尽力 */}}
    };
    // xp-asset 令牌 → 新素材 id；未登记引用落成显式 missing 占位素材（引用可见、可在素材库重绑，绝不指回旧 id）
    const mapAssetToken=oldAid=>{
      let naid=assetMap.get(oldAid);
      if(!naid){
        naid=uid('a');assetMap.set(oldAid,naid);
        newAssets[naid]={id:naid,name:`缺失素材（${String(oldAid).slice(0,24)}）`,kind:'file',mime:'application/octet-stream',size:0,addedAt:Date.now(),missing:true};
      }
      return naid;
    };
    // 节点 data 内嵌 xp-asset 令牌（导演台 editorState 等）逐令牌换绑
    const remapXpData=d=>{
      let s;try{s=JSON.stringify(d);}catch{return;}
      if(typeof s!=='string'||!s.includes('xp-asset://'))return;
      const s2=s.replace(XP_TOKEN_RE,(m0,aid)=>`xp-asset://${mapAssetToken(aid)}`);
      let d2;try{d2=JSON.parse(s2);}catch{return;}
      for(const k of Object.keys(d))delete d[k];
      Object.assign(d,d2);
    };
    try{
      // 1) 导演台 KV 先读（暂存之前）：xp-asset:// 引用一并收齐；快照里没有的记录再向源项目文档取
      const dirIds=new Set(clipboard.nodes.filter(n=>n.type==='director').map(n=>n.id));
      const kvReads=[];
      if(dirIds.size){
        for(const k of await storage.keys()){
          const m=k.match(/^(dir|dircfg):([^:]+):/);
          if(!m||!dirIds.has(m[2]))continue;
          const v=await storage.get(k);
          if(v===undefined)continue;
          kvReads.push([k,v]);
        }
      }
      const extra={};   // KV 引到但未进剪贴板快照的素材：oldAid → 记录|null（null → 显式 missing 占位）
      {
        const need=new Set();
        for(const[,v]of kvReads)scanXpTokens(v,need);
        const miss=[...need].filter(a=>!clipboard.assets?.[a]);
        const srcDoc=miss.length?await storage.get(`project:${clipboard.pid}`).catch(()=>null):null;
        for(const aid of miss)extra[aid]=srcDoc?.assets?.[aid]??null;
      }
      if(!alive())throw new Error('项目已切换，跨项目粘贴未提交');
      // 2) 素材暂存：全部写新 blob 键；缺记录/缺文件 → 显式 missing 占位
      const stage=async(oldAid,rec)=>{
        const naid=uid('a');assetMap.set(oldAid,naid);
        const a=rec?clone(rec):{name:'（缺失素材）',kind:'file',mime:'application/octet-stream',size:0,addedAt:Date.now()};
        a.id=naid;a.remote=null;delete a.deletedAt;
        const blob=rec?await storage.getBlob(`blob:${oldAid}`):null;
        if(!alive())throw new Error('项目已切换，跨项目粘贴未提交');
        if(blob&&blob.size>0){
          await storage.setBlob(`blob:${naid}`,blob);stagedBlobs.push(`blob:${naid}`);
          a.missing=false;a.size=blob.size;if(blob.type)a.mime=blob.type;
        }else a.missing=true;   // 源文件缺失 → 显式占位，由用户在素材库重绑
        newAssets[naid]=a;
      };
      for(const[oldAid,rec]of Object.entries(clipboard.assets??{}))await stage(oldAid,rec);
      for(const[oldAid,rec]of Object.entries(extra))if(!assetMap.has(oldAid))await stage(oldAid,rec);
      // 3) 纯构造（不写项目）：新节点/新分镜 + 选区外上游物化节点与连线
      const map=new Map();
      const nodes=clipboard.nodes.map(n=>{
        const c=clone(n);c.id=uid('n');map.set(n.id,c.id);c.x+=offset.x;c.y+=offset.y;
        for(const k of RUNTIME_KEYS)delete c.data[k];delete c.data[BATCH_KEY];c.data.locked=false;
        if(c.type==='asset'){const m2=assetMap.get(c.data.assetId);if(m2)c.data.assetId=m2;else{c.data.assetId=null;c.data.needsRebind=true;}}
        const fixB=b=>{if(b&&typeof b==='object')for(const k of Object.keys(b))b[k]=assetMap.get(b[k])??null;};
        fixB(c.data.bindings);fixB(c.data.draft?.bindings);
        for(const sd of Object.values(c.data.perModel??{}))fixB(sd?.bindings);
        remapXpData(c.data);
        return c;
      });
      const newShots=[];
      const shotMap=new Map();
      for(const s of clipboard.shots??[]){
        const c=clone(s);
        if((project.studio?.shots??[]).some(x=>x.id===c.id))c.id=uid('s');   // 目标已有同 id 分镜 → 换新 id 并重映射
        shotMap.set(s.id,c.id);
        c.nodeId=map.get(c.nodeId)??null;c.imageNodeId=map.get(c.imageNodeId)??null;
        if(Array.isArray(c.assetIds))c.assetIds=c.assetIds.map(x=>x==null?null:(assetMap.get(x)??null));
        if(Array.isArray(c.versions))for(const v of c.versions){if(v&&typeof v==='object'){v.nodeId=map.get(v.nodeId)??null;v.assetId=v.assetId?(assetMap.get(v.assetId)??null):null;}}
        if(c.sync&&typeof c.sync==='object'&&typeof c.sync.assetId==='string')c.sync.assetId=assetMap.get(c.sync.assetId)??null;
        newShots.push(c);
      }
      for(const c of nodes){const p=c.data?.params;if(p&&typeof p==='object')for(const[k,v]of Object.entries(p))if(/shotid$/i.test(k)&&typeof v==='string'&&shotMap.has(v))p[k]=shotMap.get(v);}
      const newEdges=[];
      for(const e of clipboard.edges){
        const to=map.get(e.to.node);if(!to)continue;
        const from=map.get(e.from.node);
        if(from){   // 选区内部连线按新 id 恢复
          newEdges.push({...clone(e),id:uid('e'),from:{...e.from,node:from},to:{...e.to,node:to}});
          continue;
        }
        // 选区外上游：按复制时快照物化来源节点——媒体口物化素材节点（缺失→显式占位），文本口物化文本节点
        const spec=clipboard.upstream?.[e.from.node];if(!spec)continue;
        const target=nodes.find(n=>n.id===to);
        const port=NODE_TYPES[target?.type]?.ports?.in?.find(p=>p.id===e.to.port);
        if(!port)continue;
        if(port.kind==='text'){
          const tn={id:uid('t'),type:'text',x:(target?.x??0)-340,y:target?.y??0,
            data:{title:spec.title?`上游文本：${spec.title}`:'上游文本（跨项目快照）',text:spec.text??'',locked:false}};
          nodes.push(tn);
          newEdges.push({id:uid('e'),from:{node:tn.id,port:'out'},to:{node:to,port:e.to.port},order:e.order??0});
        }else{
          const list=spec.assetIds?.length?spec.assetIds:[null];
          list.forEach((oldAid,idx)=>{
            const naid=oldAid?assetMap.get(oldAid):null;
            const an={id:uid('a'),type:'asset',x:(target?.x??0)-340,y:(target?.y??0)+idx*140,
              data:naid?{assetId:naid,title:spec.title?`上游输出：${spec.title}`:'上游输出（跨项目快照）',locked:false}
                       :{assetId:null,needsRebind:true,title:'上游素材缺失（跨项目占位）',locked:false}};
            nodes.push(an);
            newEdges.push({id:uid('e'),from:{node:an.id,port:'out'},to:{node:to,port:e.to.port},order:(e.order??0)+idx/1000});
          });
        }
      }
      // 4) KV 重键 + 令牌全量换绑（mapAssetToken 兜底未登记引用 → 显式 missing 占位）
      for(const[oldK,v]of kvReads){
        const m=oldK.match(/^(dir|dircfg):([^:]+):/);
        const nid=map.get(m[2]);if(!nid)continue;
        let j=JSON.stringify(v);
        if(j==null||j.length>5e6)continue;
        j=j.replace(XP_TOKEN_RE,(m0,aid)=>`xp-asset://${mapAssetToken(aid)}`);
        let val;try{val=JSON.parse(j);}catch{continue;}
        const nk=`${m[1]}:${nid}:${oldK.slice(m[0].length)}`;
        await storage.set(nk,val);writtenKV.push(nk);
      }
      // 5) 守卫 + 原子提交：项目未被切走且无外部更高修订写入 → 内存提交后必须 flush 成功才算完成
      if(!alive())throw new Error('项目已切换，跨项目粘贴未提交');
      const stored=await storage.get(`project:${project.id}`).catch(()=>null);
      if(stored&&(stored.rev??0)>(project.rev??0))throw new Error('检测到其他标签页写入，跨项目粘贴未提交');
      if(!alive())throw new Error('项目已切换，跨项目粘贴未提交');
      checkpoint();
      const st=studioState(project);
      Object.assign(project.assets,newAssets);
      st.shots.push(...newShots);
      project.nodes.push(...nodes);
      project.edges.push(...newEdges);
      const addedN=new Set(nodes.map(n=>n.id)),addedE=new Set(newEdges.map(e=>e.id));
      const addedA=new Set(Object.keys(newAssets)),addedS=new Set(newShots);
      store.touch({type:'structure'});
      try{
        await store.flush();   // 落盘失败 → 不得宣称成功
      }catch(e2){
        // 连内存一起回滚（其后的防抖落盘只会持久化干净态），并尽力把回滚态写回文档
        project.nodes=project.nodes.filter(n=>!addedN.has(n.id));
        project.edges=project.edges.filter(e=>!addedE.has(e.id));
        for(const id of addedA)delete project.assets[id];
        st.shots=(st.shots??[]).filter(s=>!addedS.has(s));
        store.touch({type:'structure'});
        try{await storage.set(`project:${project.id}`,JSON.parse(JSON.stringify(project)));}catch{/* 尽力而为 */}
        throw e2;
      }
      return nodes;
    }catch(e){
      await cleanup();
      throw e;
    }
  }
  function group(ids,title='新分组'){const members=ids.filter(id=>store.node(id));if(!members.length)return;checkpoint();const g={id:uid('g'),title,members};studioState(store.project).groups.push(g);store.touch({type:'structure'});return g;}
  return { checkpoint, undo:()=>travel(undo,redo), redo:()=>travel(redo,undo), copy,paste,pasteAcrossProject,pasteIntoCurrent:pasteAcrossProject,group,
    state(){sync();return{canUndo:undo.length>0,canRedo:redo.length>0,depth:{undo:undo.length,redo:redo.length}};},
    duplicate(ids){copy(ids);return paste();},
    delete(ids){const list=ids.filter(id=>!store.node(id)?.data.locked);if(!list.length)return;checkpoint();for(const id of list)store.removeNode(id);},
    lock(ids){checkpoint();for(const id of ids){const n=store.node(id);if(n)n.data.locked=!n.data.locked;}store.touch({type:'structure'});},
    arrange(ids,measure){const nodes=ids.map(id=>store.node(id)).filter(n=>n&&!n.data.locked);if(!nodes.length)return;checkpoint();const x=Math.min(...nodes.map(n=>n.x)),y=Math.min(...nodes.map(n=>n.y));const sizes=nodes.map(n=>measure?.(n)??{w:230,h:280});const dx=Math.max(...sizes.map(s=>s.w))+50,dy=Math.max(...sizes.map(s=>s.h))+50;nodes.forEach((n,i)=>{n.x=x+(i%4)*dx;n.y=y+Math.floor(i/4)*dy;});store.touch({type:'structure'});},
  };
}
