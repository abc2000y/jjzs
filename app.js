(() => {
"use strict";
const $ = id => document.getElementById(id);
const status = msg => $("status").textContent = msg;
const fmt = (v,n=3) => Number.isFinite(v) ? v.toFixed(n) : "数据不足";
const pct = v => Number.isFinite(v) ? (v*100).toFixed(2)+"%" : "数据不足";
const today = new Date();
const pad = n => String(n).padStart(2,"0");
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const cacheKey = code => `fund_assistant_${code}_3y_v1`;

function loadScript(url) {
  return new Promise((resolve,reject)=>{
    const s=document.createElement("script");
    s.src=url; s.async=true;
    s.onload=()=>{s.remove();resolve();};
    s.onerror=()=>{s.remove();reject(new Error("脚本加载失败："+url));};
    document.head.appendChild(s);
  });
}
function parseQuote(raw, code) {
  const p=raw.split("~");
  if(p.length<32) throw new Error("腾讯实时行情字段不完整");
  const price=Number(p[3]), prev=Number(p[4]);
  const stamp=p[30]||"";
  return {name:p[1]||code,code,price,prev,open:Number(p[5]),volume:Number(p[6]),amount:Number(p[7]),
    time:stamp.length>=14?`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)} ${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}`:"时间未知",
    change:Number.isFinite(price)&&Number.isFinite(prev)&&prev!==0?(price-prev)/prev:NaN};
}
async function getQuote(code) {
  const varName="v_"+code;
  try { delete window[varName]; } catch(e) {}
  await loadScript(`https://qt.gtimg.cn/q=${encodeURIComponent(code)}&_=${Date.now()}`);
  const raw=window[varName];
  if(typeof raw!=="string" || !raw.includes("~")) throw new Error("腾讯实时行情未返回有效数据（可能是网络限制或接口调整）");
  return parseQuote(raw,code);
}
function historyCallback(data) { window.__fundKlineResponse=data; }
async function getKlineSegment(code,start,end) {
  window.__fundKlineResponse=null;
  const callbackName="__fundKlineResponse";
  // 腾讯接口常见返回 callback({...})；同时兼容 _var 变量赋值形式。
  window[callbackName]=historyCallback;
  const param=`${code},day,${start},${end},500,qfq`;
  const url=`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=${callbackName}&param=${encodeURIComponent(param)}&_=${Date.now()}`;
  await loadScript(url);
  let obj=window.__fundKlineResponse;
  if(!obj || typeof obj!=="object") {
    const possible=window[callbackName];
    if(possible && typeof possible==="object") obj=possible;
  }
  if(!obj || typeof obj!=="object") throw new Error(`历史接口未取得数据（${start} 至 ${end}）。接口返回方式可能变化。`);
  const node=obj.data && obj.data[code];
  if(!node) throw new Error(`历史接口返回中没有基金代码 ${code}`);
  const rows=node.qfqday || node.day || node.qfqday || [];
  if(!Array.isArray(rows)) throw new Error("历史K线格式不符合预期");
  return rows.map(r=>({date:String(r[0]),open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5])}))
    .filter(r=>r.date && Number.isFinite(r.close) && r.close>0);
}
function segments3y() {
  const end=new Date();
  const start=new Date(end); start.setFullYear(start.getFullYear()-3);
  const out=[]; let cursor=new Date(start.getFullYear(),0,1);
  while(cursor<=end) {
    const y=cursor.getFullYear();
    const a=cursor<start?start:new Date(y,0,1);
    const b=new Date(y,11,31)>end?end:new Date(y,11,31);
    out.push([dateStr(a),dateStr(b)]);
    cursor=new Date(y+1,0,1);
  }
  return out;
}
async function getHistory(code) {
  const key=cacheKey(code);
  let cached=null;
  try { cached=JSON.parse(localStorage.getItem(key)||"null"); } catch(e) {}
  const now=Date.now();
  if(cached && cached.rows && cached.savedAt && now-cached.savedAt<6*60*60*1000) {
    return {rows:cached.rows,source:"本机缓存（6小时内）"};
  }
  const all=[];
  const parts=segments3y();
  for(let i=0;i<parts.length;i++) {
    const [a,b]=parts[i];
    status(`正在获取历史K线：${i+1}/${parts.length}\n${a} 至 ${b}\n请保持页面打开……`);
    const rows=await getKlineSegment(code,a,b);
    all.push(...rows);
    await new Promise(r=>setTimeout(r,350));
  }
  const map=new Map(); all.forEach(r=>map.set(r.date,r));
  const rows=[...map.values()].sort((a,b)=>a.date.localeCompare(b.date));
  if(rows.length) {
    try { localStorage.setItem(key,JSON.stringify({rows,savedAt:now})); } catch(e) {}
  }
  return {rows,source:"腾讯历史接口"};
}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;}
function sma(a,n){return a.length>=n?mean(a.slice(-n)):NaN;}
function maxDrawdown(closes){
  let peak=-Infinity,dd=0;
  for(const x of closes){peak=Math.max(peak,x);dd=Math.min(dd,x/peak-1);}
  return dd;
}
function volatility(closes){
  if(closes.length<3)return NaN;
  const r=[]; for(let i=1;i<closes.length;i++)r.push(closes[i]/closes[i-1]-1);
  const m=mean(r), variance=mean(r.map(x=>(x-m)**2));
  return Math.sqrt(variance)*Math.sqrt(250);
}
function returnSince(rows,years){
  const last=rows[rows.length-1], cutoff=new Date(last.date+"T00:00:00");
  cutoff.setFullYear(cutoff.getFullYear()-years);
  const target=rows.find(r=>new Date(r.date+"T00:00:00")>=cutoff);
  return target?last.close/target.close-1:NaN;
}
function rsi(closes,n=14){
  if(closes.length<=n)return NaN;
  let gains=0,loss=0;
  for(let i=closes.length-n;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else loss-=d;}
  if(loss===0)return gains===0?50:100;
  return 100-(100/(1+gains/loss));
}
function emaSeries(a,n){
  if(!a.length)return [];
  const k=2/(n+1),out=[a[0]];
  for(let i=1;i<a.length;i++)out.push(a[i]*k+out[i-1]*(1-k));
  return out;
}
function macd(closes){
  if(closes.length<35)return {dif:NaN,dea:NaN,hist:NaN};
  const e12=emaSeries(closes,12),e26=emaSeries(closes,26);
  const dif=e12.map((x,i)=>x-e26[i]),dea=emaSeries(dif,9),i=closes.length-1;
  return {dif:dif[i],dea:dea[i],hist:2*(dif[i]-dea[i])};
}
function metricHTML(items){return items.map(([k,v])=>`<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");}
function draw(rows){
  const c=$("chart"),ctx=c.getContext("2d"),w=c.width,h=c.height;
  ctx.clearRect(0,0,w,h);
  if(rows.length<2){ctx.fillText("历史数据不足，无法绘图",20,30);return;}
  const vals=rows.map(r=>r.close),min=Math.min(...vals),max=Math.max(...vals),pad=24;
  ctx.strokeStyle="#dce5ed";ctx.lineWidth=1;
  for(let i=0;i<5;i++){const y=pad+i*(h-2*pad)/4;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke();}
  ctx.strokeStyle="#1769aa";ctx.lineWidth=2;ctx.beginPath();
  vals.forEach((v,i)=>{const x=pad+i*(w-2*pad)/(vals.length-1),y=h-pad-(v-min)/(max-min||1)*(h-2*pad);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});
  ctx.stroke();
  ctx.fillStyle="#687789";ctx.font="12px sans-serif";ctx.fillText(max.toFixed(3),pad,14);ctx.fillText(min.toFixed(3),pad,h-5);
}
function showQuote(q){
  $("quoteMetrics").innerHTML=metricHTML([
    ["基金名称",q.name],["最新价",fmt(q.price,3)],["涨跌幅",`<span class="${q.change>=0?'up':'down'}">${pct(q.change)}</span>`],["行情时间",q.time]
  ]);
}
function showHistory(rows,source){
  const c=rows.map(r=>r.close),m=macd(c);
  $("historyMetrics").innerHTML=metricHTML([
    ["历史记录",`${rows.length} 条`],["近1年收益",pct(returnSince(rows,1))],["近3年收益",pct(returnSince(rows,3))],
    ["区间最大回撤",pct(maxDrawdown(c))],["年化波动率",pct(volatility(c))],
    ["MA20",fmt(sma(c,20),3)],["MA60",fmt(sma(c,60),3)],["MA120",fmt(sma(c,120),3)]
  ]);
  $("techMetrics").innerHTML=metricHTML([
    ["RSI(14)",fmt(rsi(c),2)],["MACD柱",fmt(m.hist,4)],["DIF",fmt(m.dif,4)],["DEA",fmt(m.dea,4)]
  ]);
  $("range").textContent=`数据区间：${rows[0]?.date||"无"} 至 ${rows.at(-1)?.date||"无"}；来源：${source}。收益与风险指标基于历史收盘价计算。`;
  $("records").innerHTML=rows.slice(-12).reverse().map(r=>`<tr><td>${r.date}</td><td>${fmt(r.open,3)}</td><td>${fmt(r.close,3)}</td><td>${fmt(r.high,3)}</td><td>${fmt(r.low,3)}</td><td>${Number.isFinite(r.volume)?Math.round(r.volume).toLocaleString():"—"}</td></tr>`).join("")||'<tr><td colspan="6">无数据</td></tr>';
  draw(rows);
}
async function run(){
  const btn=$("analyze"),code=$("fund").value;btn.disabled=true;
  $("quoteMetrics").innerHTML=metricHTML([["基金名称","读取中"],["最新价","—"],["涨跌幅","—"],["行情时间","—"]]);
  try{
    status("正在读取腾讯实时行情……");
    try { const q=await getQuote(code);showQuote(q); }
    catch(e){status("实时行情获取失败："+e.message+"\n继续尝试历史数据……");}
    const result=await getHistory(code);
    if(!result.rows.length) throw new Error("历史接口返回0条记录；未使用模拟数据填补。");
    showHistory(result.rows,result.source);
    status(`分析完成。\n基金：${code}\n历史记录：${result.rows.length} 条\n来源：${result.source}\n请核对数据区间与行情时间。`);
  }catch(e){status("本次未能完整完成："+e.message+"\n请稍后重试；若持续失败，可能是腾讯接口调整或当前网络限制。");}
  finally{btn.disabled=false;}
}
$("analyze").addEventListener("click",run);
})();