import test from 'node:test';
import assert from 'node:assert/strict';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMediaService,detectMediaTools} from './media-service.mjs';
const exec=promisify(execFile);
const run=(cmd,args)=>exec(cmd,args,{windowsHide:true,timeout:15000,maxBuffer:8*1024*1024,encoding:'buffer'});
const tools=await detectMediaTools();

test('独立验收：真实剪辑导出包含前红后蓝画面、可解码音轨与正确时长', {skip:!tools.available?'本机缺少FFmpeg':false},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'xp-independent-media-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const files=new Map();
  for(const [name,color] of [['red','red'],['blue','blue']]){
    const path=join(dir,name+'.mp4');await run('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=160x90:r=24:d=1`,'-c:v','libx264','-pix_fmt','yuv420p',path]);files.set(`media/${name}.mp4`,new Uint8Array(await readFile(path)));
  }
  const sound=join(dir,'tone.wav');await run('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2',sound]);files.set('media/tone.wav',new Uint8Array(await readFile(sound)));
  const clip=(file,start,end)=>({file,start,end,in:0,speed:1,volume:0,fadeIn:0,fadeOut:0});
  const job={format:'xp-render@1',version:1,output:{width:320,height:180,fps:24,format:'mp4',background:'#000000'},duration:2,tracks:{video:[clip('media/red.mp4',0,1),clip('media/blue.mp4',1,2)],overlay:[],audio:[{...clip('media/tone.wav',0,2),volume:0.5,track:'a1'}],subtitle:[]},media:[...files].map(([key,data])=>({key,assetId:key,name:key.split('/').at(-1),kind:key.endsWith('.wav')?'audio':'video',mime:key.endsWith('.wav')?'audio/wav':'video/mp4',size:data.length}))};
  const result=await createMediaService({tmpRoot:dir}).render(job,files);t.after(()=>result.cleanup());
  const probe=JSON.parse((await run('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,width,height:format=duration','-of','json',result.path])).stdout.toString());
  assert.ok(probe.streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'),'导出必须使用浏览器能解码的 H.264，不能静默退到 MPEG-4 Part 2');
  assert.ok(Math.abs(Number(probe.format.duration)-2)<0.15);assert.ok(probe.streams.some(s=>s.codec_type==='audio'));assert.ok(probe.streams.some(s=>s.width===320&&s.height===180));
  const rgb=async second=>{const b=(await run('ffmpeg',['-v','error','-ss',String(second),'-i',result.path,'-frames:v','1','-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])).stdout;return [...b.subarray(0,3)];};
  const first=await rgb(.3),second=await rgb(1.3);assert.ok(first[0]>first[2]+100,`前段应为红色：${first}`);assert.ok(second[2]>second[0]+100,`后段应为蓝色：${second}`);
  const pcm=(await run('ffmpeg',['-v','error','-i',result.path,'-vn','-ac','1','-ar','8000','-f','s16le','pipe:1'])).stdout;let sum=0;for(let i=0;i+1<pcm.length;i+=2)sum+=pcm.readInt16LE(i)**2;assert.ok(Math.sqrt(sum/(pcm.length/2))>100,'音轨必须有可听信号，不能仅有静音容器');
});

test('独立验收：取消发生在 ffprobe 阶段也要及时传播且不启动 ffmpeg',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'xp-independent-cancel-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let probeEntered;const entered=new Promise(r=>probeEntered=r);let encodes=0;
  const fake=(_cmd,args,options)=>{if(args.includes('-show_entries')){probeEntered();return new Promise((_,reject)=>options.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'})),{once:true}));}encodes++;return Promise.resolve({stdout:'',stderr:'',code:0});};
  const svc=createMediaService({tmpRoot:dir,tools:{available:true,canMp4:true,filters:{},encoders:{}},spawnImpl:fake});const ac=new AbortController();
  const job={format:'xp-render@1',version:1,output:{width:320,height:180,fps:24,format:'mp4',background:'#000000'},duration:1,tracks:{video:[{file:'media/a.mp4',start:0,end:1,in:0,speed:1,volume:0,fadeIn:0,fadeOut:0}],overlay:[],audio:[],subtitle:[]},media:[{key:'media/a.mp4',assetId:'a',name:'a.mp4',kind:'video',mime:'video/mp4',size:1}]};
  const operation=svc.render(job,new Map([['media/a.mp4',new Uint8Array([1])]]),{signal:ac.signal}).then(()=> 'resolved',e=>e.name);await entered;ac.abort();
  let timer;const result=await Promise.race([operation,new Promise(r=>timer=setTimeout(()=>r('timeout'),250))]);clearTimeout(timer);assert.equal(result,'AbortError');assert.equal(encodes,0);
});
