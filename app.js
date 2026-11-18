const DEFAULT_SYMBOLS = ["ASTS", "RKLB", "IONQ", "OKLO"];
const NAMES = {
  ASTS:"AST SpaceMobile",RKLB:"Rocket Lab",IONQ:"IonQ",OKLO:"Oklo",
  NVDA:"NVIDIA",AMD:"Advanced Micro Devices",TSLA:"Tesla",PLTR:"Palantir",
  SOFI:"SoFi Technologies",AVGO:"Broadcom",HOOD:"Robinhood",SMR:"NuScale Power",
  JOBY:"Joby Aviation",ACHR:"Archer Aviation",MSFT:"Microsoft",AMZN:"Amazon",
  META:"Meta Platforms",ARM:"Arm Holdings",COIN:"Coinbase",LUNR:"Intuitive Machines"
};
const $ = s => document.querySelector(s);
const fmt = n => Number.isFinite(n) ? n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}) : "—";
const state = {
  busy:false,
  intradayBusy:false,
  symbols:loadSavedSymbols(),
  assets:[],
  market:{},
  timeframe:"1Day",
  apiUrl:localStorage.getItem("stockWatcherApiUrl") || "https://ai-stock-watcher-api.bombbomb725.workers.dev",
  sessionToken:localStorage.getItem("stockWatcherSessionToken")||sessionStorage.getItem("stockWatcherSessionToken")||"",
  user:null,
  shared:false,
  focusSymbol:(new URLSearchParams(location.search).get("symbol")||"").trim().toUpperCase()
};
function loadSavedSymbols(){
  try {
    const saved = JSON.parse(localStorage.getItem("stockWatcherSymbols") || "null");
    return Array.isArray(saved) ? [...new Set(saved.filter(s=>typeof s==="string" && /^[A-Z][A-Z0-9.]{0,9}$/.test(s))) ] : [...DEFAULT_SYMBOLS];
  } catch { return [...DEFAULT_SYMBOLS]; }
}
function saveSymbols(){ localStorage.setItem("stockWatcherSymbols",JSON.stringify(state.symbols)); }
function ema(values,period){
  if(values.length<period)return null;
  const k=2/(period+1);
  let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
  return v;
}
function emaSeries(values,period){
  const out=Array(values.length).fill(null);
  if(values.length<period)return out;
  const k=2/(period+1);
  let v=values.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period-1]=v;
  for(let i=period;i<values.length;i++){v=values[i]*k+v*(1-k);out[i]=v;}
  return out;
}
function rsi(values,period=14){
  if(values.length<=period)return null;
  let gain=0,loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d;}
  let avgGain=gain/period,avgLoss=loss/period;
  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    avgGain=(avgGain*(period-1)+Math.max(d,0))/period;
    avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;
  }
  if(avgLoss===0)return 100;
  const rs=avgGain/avgLoss;
  return 100-100/(1+rs);
}
function macdData(values){
  if(values.length<35)return null;
  const e12=emaSeries(values,12),e26=emaSeries(values,26);
  const line=values.map((_,i)=>e12[i]!==null&&e26[i]!==null?e12[i]-e26[i]:null);
  const valid=line.filter(Number.isFinite);
  if(valid.length<9)return null;
  const signalValid=emaSeries(valid,9);
  const signal=signalValid[signalValid.length-1];
  const macd=line[line.length-1];
  return {line:macd,signal,hist:macd-signal};
}
function completedBars(bars,timeframe="1Day",timezone="America/New_York"){
  if(!bars.length)return [];
  if(timeframe==="4Hour"){
    const last=bars[bars.length-1],start=last.t?new Date(last.t).getTime():NaN;
    return Number.isFinite(start)&&start+4*60*60*1000>Date.now()?bars.slice(0,-1):bars;
  }
  const last=bars[bars.length-1];
  const date=last.t?new Date(last.t):null;
  if(!date)return bars;
  const fmtDate=d=>new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
  return fmtDate(date)===fmtDate(new Date())?bars.slice(0,-1):bars;
}
function adxValue(bars,period=14) {
  if(!Array.isArray(bars)||bars.length<period*2+1)return null;
  const tr=[],plusDM=[],minusDM=[];
  for(let i=1;i<bars.length;i++){
    const h=Number(bars[i].h),l=Number(bars[i].l),pc=Number(bars[i-1].c);
    const ph=Number(bars[i-1].h),pl=Number(bars[i-1].l);
    if(![h,l,pc,ph,pl].every(Number.isFinite))continue;
    const up=h-ph,down=pl-l;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    plusDM.push(up>down&&up>0?up:0);
    minusDM.push(down>up&&down>0?down:0);
  }
  if(tr.length<period*2)return null;
  let smTR=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let smP=plusDM.slice(0,period).reduce((a,b)=>a+b,0);
  let smM=minusDM.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=period-1;i<tr.length;i++){
    if(i>=period){smTR=smTR-smTR/period+tr[i];smP=smP-smP/period+plusDM[i];smM=smM-smM/period+minusDM[i];}
    const pdi=smTR?100*smP/smTR:0,mdi=smTR?100*smM/smTR:0;
    dx.push(pdi+mdi?100*Math.abs(pdi-mdi)/(pdi+mdi):0);
  }
  if(dx.length<period)return null;
  let value=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<dx.length;i++)value=(value*(period-1)+dx[i])/period;
  return value;
}
function analyze(bars,price,timeframe=state.timeframe,timezone="America/New_York"){
  const done=completedBars(bars,timeframe,timezone);
  const closes=done.map(b=>Number(b.c)).filter(Number.isFinite);
  if(closes.length<55)return {signal:"ข้อมูลย้อนหลังไม่พอ",kind:"wait",score:0,short:null,long:null,rsi:null,macd:null,confirmed:false,strong:false};
  const short=ema(closes,20),long=ema(closes,50),momentum=rsi(closes),m=macdData(closes),adx=adxValue(done);
  const e20s=emaSeries(closes,20),e50s=emaSeries(closes,50);
  const rising20=e20s.at(-1)>e20s.at(-6),rising50=e50s.at(-1)>e50s.at(-6),lastClose=closes.at(-1);
  const trend=short>long&&rising20&&rising50&&lastClose>short;
  const rsiOK=momentum>=50&&momentum<70,macdOK=Boolean(m&&m.line>m.signal&&m.hist>0),trendStrengthOK=Number.isFinite(adx)&&adx>=18;
  const confirmed=Boolean(trend&&rsiOK&&macdOK&&trendStrengthOK);
  const prior=done.slice(-21,-1),priorHigh=prior.length?Math.max(...prior.map(b=>Number(b.h)).filter(Number.isFinite)):null;
  const lastVolume=Number(done.at(-1)?.v),avgVolume=prior.map(b=>Number(b.v)).filter(Number.isFinite);
  const volumeAvg=avgVolume.length?avgVolume.reduce((x,y)=>x+y,0)/avgVolume.length:0;
  const breakout=Number.isFinite(lastClose)&&Number.isFinite(priorHigh)&&lastClose>priorHigh;
  const volumeOK=volumeAvg>0&&lastVolume>=volumeAvg*1.3;
  const strong=confirmed&&breakout&&volumeOK;
  const score=[trend,rsiOK,macdOK,breakout,volumeOK].filter(Boolean).length;
  let signal="รอการยืนยันแนวโน้ม",kind="wait";
  if(strong){signal="ขาขึ้นแข็งแรง + เบรกเอาต์และวอลุ่มยืนยัน";kind="buy";}
  else if(confirmed){signal="BUY SIGNAL · แนวโน้มและ ADX ยืนยัน";kind="buy";}
  else if(momentum<45||(!trend&&lastClose<short&&short<long)){signal="แนวโน้มยังอ่อน";kind="risk";}
  else if(lastClose>short&&!trend){signal="เริ่มฟื้นตัว · รอยืนยัน";kind="wait";}
  return {short,long,rsi:momentum,macd:m?.line??null,macdSignal:m?.signal??null,adx,score,signal,kind,confirmed,strong,lastClose,priorHigh,breakout,volumeOK};
}
function atrValue(bars,period=14){
  if(bars.length<period+1)return null;
  const tr=[];
  for(let i=1;i<bars.length;i++){
    const h=Number(bars[i].h),l=Number(bars[i].l),pc=Number(bars[i-1].c);
    if([h,l,pc].every(Number.isFinite))tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return tr.length>=period?tr.slice(-period).reduce((a,b)=>a+b,0)/period:null;
}
function chartSvg(bars,livePrice,caption="กราฟย้อนหลัง · รายวัน"){
 const rows=bars.slice(-48).filter(b=>[b.o,b.h,b.l,b.c].every(v=>Number.isFinite(Number(v))));
 if(rows.length<2)return '<div class="chart-empty">ข้อมูลกราฟยังไม่เพียงพอ · มี '+rows.length+' แท่ง</div>';
 const closes=rows.map(b=>Number(b.c)),e20=emaSeries(closes,20),e50=emaSeries(closes,50);
 const values=rows.flatMap(b=>[Number(b.h),Number(b.l)]).concat(e20.filter(Number.isFinite),e50.filter(Number.isFinite),Number.isFinite(livePrice)?[livePrice]:[]);
 let lo=Math.min(...values),hi=Math.max(...values),pad=(hi-lo)*.12||1;lo-=pad;hi+=pad;
 const X=i=>38+i*(540/Math.max(1,rows.length-1)),Y=v=>12+(hi-v)/(hi-lo)*150,close=String.fromCharCode(60,47);
 const width=Math.max(3,Math.min(9,Math.floor(500/rows.length*.55)));
 const line=a=>a.map((v,i)=>Number.isFinite(v)?(i&&Number.isFinite(a[i-1])?"L":"M")+X(i).toFixed(1)+","+Y(v).toFixed(1):"").join(" ");
 const candles=rows.map((b,i)=>{const o=Number(b.o),h=Number(b.h),l=Number(b.l),c=Number(b.c),up=c>=o,top=Y(Math.max(o,c)),bottom=Y(Math.min(o,c)),x=X(i);return '<g class="candle '+(up?"up":"down")+'"><line x1="'+x.toFixed(1)+'" y1="'+Y(h).toFixed(1)+'" x2="'+x.toFixed(1)+'" y2="'+Y(l).toFixed(1)+'"/><rect x="'+(x-width/2).toFixed(1)+'" y="'+top.toFixed(1)+'" width="'+width+'" height="'+Math.max(1,bottom-top).toFixed(1)+'" rx="1"/>'+close+'g>'}).join("");
 const live=Number.isFinite(livePrice)?'<line x1="30" y1="'+Y(livePrice).toFixed(1)+'" x2="590" y2="'+Y(livePrice).toFixed(1)+'" class="live-price-line"/>':"";
 return '<div class="chart-wrap"><div class="chart-caption">'+caption+' · Candlestick / EMA20 / EMA50</div><svg class="price-chart" viewBox="0 0 610 180" role="img" aria-label="กราฟแท่งเทียนราคา EMA20 EMA50"><line x1="30" y1="45" x2="590" y2="45" class="chart-grid"/><line x1="30" y1="95" x2="590" y2="95" class="chart-grid"/><line x1="30" y1="145" x2="590" y2="145" class="chart-grid"/>'+live+candles+'<path d="'+line(e20)+'" class="line-ema20"/><path d="'+line(e50)+'" class="line-ema50"/>'+close+'svg><div class="chart-legend"><span class="legend-candle">แท่งเขียว/แดง = ขึ้น/ลง</span><span>EMA20</span><span>EMA50</span></div>'+close+'div>';
}
async function resolveSymbols(symbols){
  return Promise.all(symbols.map(async raw=>{
    const symbol=String(raw||"").trim().toUpperCase();
    if(!/^[A-Z0-9]{1,8}$/.test(symbol)||isThaiSymbol(symbol))return symbol;
    try{
      const url=state.apiUrl.replace(/\/$/,"")+"/api/assets?q="+encodeURIComponent(symbol);
      const response=await fetch(url,{cache:"no-store"});
      if(!response.ok)return symbol;
      const data=await response.json(),matches=data.assets||[];
      const us=matches.some(x=>x.market==="US"&&String(x.symbol||"").toUpperCase()===symbol);
      const thai=matches.find(x=>x.market==="THAI"&&String(x.symbol||"").toUpperCase()===symbol+".BK");
      return thai&&!us?symbol+".BK":symbol;
    }catch{return symbol;}
  }));
}
function isThaiSymbol(symbol){return /^[A-Z0-9]{1,8}\.BK$/.test(String(symbol||"").toUpperCase());}
function marketCurrency(symbol){return isThaiSymbol(symbol)?"฿":"$";}
function entryPlan(bars,a,symbol){
  const done=completedBars(bars,state.timeframe,isThaiSymbol(symbol)?"Asia/Bangkok":"America/New_York"),atr=atrValue(done),e20=a.short;
  if(!Number.isFinite(atr)||!Number.isFinite(e20))return null;
  const lows=done.slice(-20).map(b=>Number(b.l)).filter(Number.isFinite);
  const support=lows.length?Math.min(...lows):e20-atr;
  const low=Math.max(e20-.35*atr,e20*.985);
  const high=e20+.15*atr;
  const stop=Math.min(support,e20-1.2*atr);
  const risk=Math.max(high-stop,atr*.5);
  return {low,high,stop,target:high+2*risk};
}
function renderCard(symbol,item){
  const thai=isThaiSymbol(symbol),currency=marketCurrency(symbol);
  const bars=item.bars||[],lastBar=bars[bars.length-1],tradePrice=Number(item.trade?.p),price=Number.isFinite(tradePrice)&&tradePrice>0?tradePrice:Number(lastBar?.c),priceTime=item.trade?.t||lastBar?.t,a=analyze(bars,price,state.timeframe,thai?"Asia/Bangkok":"America/New_York");
  if(item.signal){
    a.kind=item.signal.status||a.kind;
    a.signal=item.signal.status_label||a.signal;
    a.score=Number.isFinite(Number(item.signal.score))?Number(item.signal.score):a.score;
    a.confirmed=a.kind==="buy";
    a.strong=String(a.signal).includes("เบรกเอาต์");
  }
  const plan=entryPlan(bars,a,symbol);
  const prev=bars.length>1?Number(bars[bars.length-2].c):NaN;
  const change=Number.isFinite(price)&&Number.isFinite(prev)&&prev!==0?(price-prev)/prev*100:null;
  const cls=change===null?"neutral":change>=0?"positive":"negative";
  const completedHistory=completedBars(bars,state.timeframe,thai?"Asia/Bangkok":"America/New_York");
  const dataReady=!item.stale&&completedHistory.length>=55&&Number.isFinite(price)&&price>0;
  const decision=!dataReady
    ? {label:"รอข้อมูล",tone:"yellow",detail:item.stale?"ข้อมูลที่แสดงเป็นข้อมูลย้อนหลังจากแคช ไม่ใช่ราคาล่าสุด จึงงดประเมินจังหวะซื้อ":"ราคาล่าสุดหรือข้อมูลย้อนหลังยังไม่ครบ จึงยังประเมินจังหวะซื้อไม่ได้"}
    : a.kind==="buy"
    ? {label:"ซื้อได้",tone:"green",detail:a.strong?"แนวโน้มขาขึ้นยืนยันแล้ว และราคาทะลุจุดสูงเดิมพร้อมวอลุ่ม":"แนวโน้มขาขึ้นผ่านเงื่อนไขหลักแล้ว แต่ควรรอเข้าตามโซน ไม่ไล่ราคา"}
    : a.kind==="risk"
    ? {label:"อย่าเพิ่งซื้อ",tone:"red",detail:"แนวโน้มยังอ่อนหรือโมเมนตัมไม่สนับสนุน รอให้สัญญาณกลับตัวก่อน"}
    : {label:"เตรียมซื้อ",tone:"yellow",detail:"เริ่มมีสัญญาณฟื้นตัวหรือยังยืนยันไม่ครบ รอดูแท่งวันถัดไปและเงื่อนไขให้ครบก่อน"};
  const decisionHtml='<section class="decision '+decision.tone+'"><div class="decision-heading"><span>สรุปง่ายๆ</span><b>'+decision.label+'</b></div><p>'+decision.detail+'</p></section>';
  const planHtml=plan?`<section class="entry-plan"><div class="entry-title">โซนราคาเฝ้ารอเข้าซื้อเมื่อกลับตัวเป็นขาขึ้น</div><div class="entry-range">${currency}${fmt(plan.low)} – ${currency}${fmt(plan.high)}</div><div class="entry-levels"><span>เป้าหมาย 2R <b>${currency}${fmt(plan.target)}</b></span><span>จุดตัดขาดทุน <b>${currency}${fmt(plan.stop)}</b></span></div><small>${a.confirmed?'แนวโน้มผ่านเงื่อนไขแล้ว รอราคาเข้ามาในโซนนี้ ไม่ไล่ซื้อ':'ระดับประมาณการล่วงหน้า ยังไม่ใช่สัญญาณซื้อ รอให้สถานะเป็นสีเขียวก่อน'}</small></section>`:"";
  const time=priceTime?new Date(priceTime).toLocaleString("th-TH",{timeZone:thai?"Asia/Bangkok":"America/New_York"}):"ไม่พบราคาปิดล่าสุด";
  const providerError=item.error?'<div class="data-warning">แหล่งข้อมูลขัดข้อง: '+escapeHtml(item.error)+'</div>':(!dataReady?'<div class="data-warning">ยังไม่มีราคา/แท่งย้อนหลังเพียงพอ จึงงดประเมินสัญญาณซื้อ</div>':'');
  const displaySymbol=String(symbol).replace(/\.BK$/i,"");
  return '<article class="stock-card"><div class="stock-head"><div><div class="symbol">'+escapeHtml(displaySymbol)+'</div><div class="company">'+(state.assetNames?.[symbol]||NAMES[symbol]||(thai?"หุ้นไทย · SET/mai":"หุ้นสหรัฐฯ"))+'</div></div><div class="card-actions"><span class="signal '+a.kind+'">'+a.signal+'</span>'+(state.symbols.includes(symbol)?'<button class="remove-stock" data-remove="'+symbol+'" aria-label="ลบ '+symbol+'">×</button>':'')+'</div></div><div class="price">'+(Number.isFinite(price)?currency+fmt(price):"ไม่มีราคาล่าสุด")+'</div><div class="change '+cls+'">'+(change===null?"เทียบราคาปิดไม่ได้":(change>=0?"+":"")+change.toFixed(2)+"% จากแท่งก่อนหน้า")+'</div><div class="quote-time">ราคาล่าสุด: '+(priceTime?new Date(priceTime).toLocaleTimeString("th-TH",{timeZone:thai?"Asia/Bangkok":"America/New_York"}):"ไม่มีเวลาอ้างอิง")+(priceTime?" · "+(thai?"เวลาไทย":"เวลานิวยอร์ก"):"")+'</div>'+providerError+decisionHtml+chartSvg((item.intradayBars||[]).filter(b=>[b.o,b.h,b.l,b.c].every(v=>Number.isFinite(Number(v)))).length>=2?item.intradayBars:bars,price,(item.intradayBars||[]).filter(b=>[b.o,b.h,b.l,b.c].every(v=>Number.isFinite(Number(v)))).length>=2?"กราฟระหว่างวัน · แท่ง 5 นาที":"กราฟย้อนหลัง · รายวัน")+'<div class="metrics"><div class="metric"><span>EMA20 / EMA50</span><b>'+fmt(a.short)+' / '+fmt(a.long)+'</b></div><div class="metric"><span>RSI14</span><b>'+fmt(a.rsi)+'</b></div><div class="metric"><span>MACD</span><b>'+fmt(a.macd)+'</b></div><div class="metric"><span>ADX14</span><b>'+fmt(a.adx)+'</b></div></div>'+planHtml+'<div class="card-foot">ราคาปิดล่าสุด: '+time+' · คะแนน '+a.score+'/5 · สถานะ/คะแนนอิงผลสแกน 1D '+(item.signal?.checked_at?new Date(item.signal.checked_at).toLocaleString("th-TH",{timeZone:"Asia/Bangkok"}):"รอผลสแกน")+' · '+(thai?'DataCedar · ราคาปิดรายวัน (อาจล่าช้า)':'Alpaca IEX')+'</div></article>';
}
function setStatus(msg,ok=false){
  $("#connection").textContent=msg;
  const dot=document.querySelector(".live-dot");
  if(dot)dot.style.background=ok?"#3bd69b":"#f5c96a";
}
function escapeHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function renderWatchlist(){ $("#watchlist").textContent="กำลังติดตาม "+state.symbols.length+"/50 หุ้น · สหรัฐฯ "+state.symbols.filter(s=>!isThaiSymbol(s)).length+" · ไทย "+state.symbols.filter(isThaiSymbol).length+(state.shared?" · ซิงก์กับ LINE แล้ว":" · ยังไม่ซิงก์"); }
function renderMarketCards(symbols,market){
 const us=symbols.filter(s=>!isThaiSymbol(s)),thai=symbols.filter(isThaiSymbol);
 $("#usCards").innerHTML=us.length?us.map(s=>market[s]?renderCard(s,market[s]):'<article class="stock-card"><b>'+escapeHtml(s)+'</b><p>ไม่พบข้อมูลจาก Alpaca IEX</p></article>').join(""):'<article class="stock-card empty-market">ยังไม่มีหุ้นสหรัฐฯ ในรายการติดตาม</article>';
 $("#thaiCards").innerHTML=thai.length?thai.map(s=>market[s]?renderCard(s,market[s]):'<article class="stock-card"><b>'+escapeHtml(s)+'</b><p>ไม่พบข้อมูลจากแหล่งหุ้นไทย</p></article>').join(""):'<article class="stock-card empty-market">ยังไม่ได้เพิ่มหุ้นไทยใน Watchlist · ค้นหาชื่อหรือตัวย่อหุ้นไทยด้านบน</article>';
}
async function apiRequest(path,options={}) {
  const headers={"Content-Type":"application/json",...(options.headers||{})};
  if(state.sessionToken)headers.Authorization="Bearer "+state.sessionToken;
  const response=await fetch(state.apiUrl.replace(/\/$/,"")+path,{...options,headers,cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
  return data;
}
function showPairingCode(code) {
  $("#accountStatus").innerHTML='ยังไม่เชื่อม LINE · เปิดแชตบอต AI Stock Watcher แล้วพิมพ์ <b>เชื่อม '+escapeHtml(code)+'</b> · รหัสหมดอายุใน 10 นาที';
}
async function activateSharedAccount(data) {
  // Once LINE is linked, the server-side D1 watchlist is the sole source of truth.
  // Never merge browser localStorage into it: localStorage may contain symbols
  // that the user deliberately removed from LINE on another device.
  state.user=data.user||null;
  state.shared=true;
  const current=await apiRequest("/api/me");
  state.symbols=Array.isArray(current.symbols)?current.symbols:(Array.isArray(data.symbols)?data.symbols:[]);
  state.user=current.user||state.user;
  saveSymbols();
  sessionStorage.removeItem("stockWatcherLinkCode");
  sessionStorage.removeItem("stockWatcherLinkExpiry");
  renderWatchlist();
  $("#accountStatus").textContent="เชื่อม LINE แล้ว"+(state.user?.displayName?" · "+state.user.displayName:"")+" · ใช้ Watchlist จากบัญชี LINE เป็นรายการหลัก";
  setStatus("บัญชี LINE เชื่อมแล้ว",true);
  loadMarket();
}
async function pollLineLink() {
  if(!state.sessionToken)return;
  try {
    const data=await apiRequest("/api/link/status");
    if(data.linked){await activateSharedAccount(data);return;}
    const code=sessionStorage.getItem("stockWatcherLinkCode");
    if(code)showPairingCode(code);
  } catch(e) {
    localStorage.removeItem("stockWatcherSessionToken");sessionStorage.removeItem("stockWatcherSessionToken");
    sessionStorage.removeItem("stockWatcherLinkCode");
    sessionStorage.removeItem("stockWatcherLinkExpiry");
    state.sessionToken="";
    $("#accountStatus").textContent="การเชื่อมต่อหมดอายุ กำลังสร้างรหัสใหม่…";
    await startLinePairing();
    return;
  }
  setTimeout(pollLineLink,3000);
}
async function startLinePairing() {
  let code=sessionStorage.getItem("stockWatcherLinkCode");
  let expiry=Number(sessionStorage.getItem("stockWatcherLinkExpiry")||0);
  if(!state.sessionToken||!code||expiry<=Date.now()) {
    const data=await apiRequest("/api/link/start",{method:"POST",body:"{}"});
    state.sessionToken=data.token;
    localStorage.setItem("stockWatcherSessionToken",data.token);sessionStorage.setItem("stockWatcherSessionToken",data.token);
    sessionStorage.setItem("stockWatcherLinkCode",data.code);
    sessionStorage.setItem("stockWatcherLinkExpiry",String(data.expiresAt*1000));
    code=data.code;
  }
  showPairingCode(code);
  setTimeout(pollLineLink,1200);
}
async function syncSharedWatchlist() {
  if(!state.shared||state.busy)return;
  try {
    const data=await apiRequest("/api/me");
    const next=data.symbols||[];
    if(JSON.stringify(next)!==JSON.stringify(state.symbols)) {
      state.symbols=next;
      saveSymbols();
      renderWatchlist();
      loadMarket();
    }
  } catch(e) {
    if(e.message.includes("เข้าสู่ระบบ")) {
      state.shared=false;
      state.user=null;
      renderWatchlist();
      $("#accountStatus").textContent="เซสชันหมดอายุ กรุณาเชื่อม LINE ใหม่";
    }
  }
}
async function initializeAccount() {
  state.user=null;
  renderWatchlist();
  try {
    if(state.sessionToken) {
      const data=await apiRequest("/api/link/status");
      if(data.linked){await activateSharedAccount(data);return;}
    }
    await startLinePairing();
    setStatus("รอเชื่อมบัญชี LINE");
    loadMarket();
  } catch(e) {
    state.sessionToken="";
    localStorage.removeItem("stockWatcherSessionToken");sessionStorage.removeItem("stockWatcherSessionToken");
    sessionStorage.removeItem("stockWatcherLinkCode");
    sessionStorage.removeItem("stockWatcherLinkExpiry");
    try {
      await startLinePairing();
      setStatus("รอเชื่อมบัญชี LINE");
    } catch(err) {
      $("#accountStatus").textContent="เชื่อมต่อระบบจับคู่ LINE ไม่สำเร็จ: "+err.message;
      setStatus("เชื่อมต่อบัญชีไม่สำเร็จ");
    }
    loadMarket();
  }
}
async function removeSymbol(symbol) {
  try {
    if(state.shared) {
      const data=await apiRequest("/api/watchlist/remove",{method:"POST",body:JSON.stringify({symbol})});
      state.symbols=data.symbols||[];
    } else {
      state.symbols=state.symbols.filter(s=>s!==symbol);
    }
    saveSymbols();
    renderWatchlist();
    loadMarket();
  } catch(e) {setStatus("ลบหุ้นไม่สำเร็จ: "+e.message);}
}
async function fetchMarket(symbols,timeframe=state.timeframe){
  const result={},groups=[symbols.filter(s=>!isThaiSymbol(s)),symbols.filter(isThaiSymbol)].filter(group=>group.length);
  const outcomes=await Promise.allSettled(groups.map(async group=>{
    const url=state.apiUrl.replace(/\/$/,"")+"/api/market?symbols="+encodeURIComponent(group.join(","))+"&timeframe="+encodeURIComponent(timeframe);
    const response=await fetch(url,{cache:"no-store"}),data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
    return data.stocks||{};
  }));
  let successes=0;const errors=[];
  for(const outcome of outcomes){if(outcome.status==="fulfilled"){Object.assign(result,outcome.value);successes++;}else errors.push(String(outcome.reason));}
  if(!successes&&errors.length)throw new Error(errors.join(" · "));
  if(errors.length)console.warn("MARKET_PROVIDER_ERRORS",errors);
  return result;
}
async function fetchSignals(symbols){
  const url=state.apiUrl.replace(/\/$/,"")+"/api/signals?symbols="+encodeURIComponent(symbols.join(","));
  const response=await fetch(url,{cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
  return data.signals||{};
}
async function fetchLatestQuotes(symbols){
  const url=state.apiUrl.replace(/\/$/,"")+"/api/quotes?symbols="+encodeURIComponent(symbols.join(","));
  const response=await fetch(url,{cache:"no-store"});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.error||("HTTP "+response.status));
  return data;
}
function marketSessionStatus(){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 const v=Object.fromEntries(parts.map(p=>[p.type,p.value]));
 const mins=Number(v.hour)*60+Number(v.minute),weekday=v.weekday!=='Sat'&&v.weekday!=='Sun';
 if(!weekday)return {label:'ตลาดสหรัฐฯ ปิด',kind:'closed',detail:'วันหยุดสุดสัปดาห์ · แสดงราคาล่าสุด'};
 if(mins>=570&&mins<960)return {label:'ตลาดสหรัฐฯ เปิด',kind:'open',detail:'ซื้อขายปกติ · ราคาจาก Alpaca IEX'};
 if(mins>=240&&mins<570)return {label:'Pre-market',kind:'pre',detail:'ก่อนตลาดเปิด · ข้อมูลอาจมีจำกัด'};
 if(mins>=960&&mins<1200)return {label:'After-hours',kind:'post',detail:'นอกเวลาซื้อขายปกติ · ข้อมูลอาจมีจำกัด'};
 return {label:'ตลาดสหรัฐฯ ปิด',kind:'closed',detail:'รอรอบซื้อขายถัดไป'};
}
function updateMarketStatus(){const el=$('#marketStatus');if(!el)return;const s=marketSessionStatus();el.className='market-status '+s.kind;el.innerHTML='<span class="market-status-dot"></span><b>'+s.label+'</b><small>'+s.detail+'</small>';}
function isUsRegularSession(){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const v=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const minutes=Number(v.hour)*60+Number(v.minute);
  return v.weekday!=="Sat"&&v.weekday!=="Sun"&&minutes>=570&&minutes<960;
}
async function refreshIntradayBars(){
  if(!isUsRegularSession()||document.hidden||state.busy||state.intradayBusy||!Object.keys(state.market).length)return;
  const symbols=Object.keys(state.market).filter(s=>!isThaiSymbol(s));
  state.intradayBusy=true;
  try{
    const data=await fetchMarket(symbols,"5Min");
    for(const symbol of symbols){
      if(!state.market[symbol]||!data[symbol])continue;
      state.market[symbol].intradayBars=data[symbol].bars||state.market[symbol].intradayBars||[];
      if(data[symbol].trade)state.market[symbol].trade=data[symbol].trade;
    }
    renderMarketCards(symbols,state.market);
    $("#updated").textContent="อัปเดตกราฟระหว่างวัน "+new Date().toLocaleTimeString("th-TH")+" · แท่ง 5 นาที";
  }catch(e){console.warn("INTRADAY_BAR_REFRESH_FAILED",e);}
  finally{state.intradayBusy=false;}
}
async function refreshLiveQuotes(){
  if(!isUsRegularSession()||document.hidden||state.busy||!Object.keys(state.market).length)return;
  const symbols=[...new Set([...state.symbols.filter(s=>!isThaiSymbol(s)),...(state.focusSymbol&&!isThaiSymbol(state.focusSymbol)?[state.focusSymbol]:[])])];
  if(!symbols.length)return;
  try{
    const [data,signals]=await Promise.all([fetchLatestQuotes(symbols),fetchSignals(symbols)]);
    for(const symbol of symbols){
      if(state.market[symbol]&&signals[symbol])state.market[symbol].signal=signals[symbol];
      const trade=data.trades?.[symbol];
      if(trade&&state.market[symbol])state.market[symbol].trade=trade;
    }
    renderMarketCards(symbols,state.market);
    $("#updated").textContent="อัปเดตราคาสด "+new Date().toLocaleTimeString("th-TH")+" · Alpaca IEX · รีเฟรชทุก 15 วินาทีขณะตลาดเปิด";
    setStatus("ตลาดสหรัฐฯ เปิด · อัปเดตราคาสดอัตโนมัติ",true);
  }catch(e){console.warn("LIVE_QUOTE_REFRESH_FAILED",e);}
}
function maybeNotify(symbol,item){
  if(!("Notification" in window)||Notification.permission!=="granted")return;
  const thai=isThaiSymbol(symbol),price=Number(item.trade?.p),a=analyze(item.bars||[],price,state.timeframe,thai?"Asia/Bangkok":"America/New_York");
  if(!a.confirmed)return;
  const day=new Intl.DateTimeFormat("en-CA",{timeZone:thai?"Asia/Bangkok":"America/New_York"}).format(new Date()),key="stockWatcherAlert_"+symbol;
  if(localStorage.getItem(key)===day)return;
  new Notification("AI Stock Watcher: "+symbol,{body:"ยืนยันแนวโน้มขาขึ้น · คะแนน "+a.score+"/5 · ราคา "+(Number.isFinite(price)?marketCurrency(symbol)+fmt(price):"ไม่ทราบ")});
  localStorage.setItem(key,day);
}
async function loadMarket(){
  if(state.busy)return;
  state.busy=true;$("#refresh").disabled=true;$("#refresh").textContent="กำลังโหลด…";
  setStatus("กำลังดึงข้อมูลตลาด");
  try{
    if(!state.symbols.length){renderMarketCards([],{});return;}
    const normalized=await resolveSymbols(state.symbols);
    if(normalized.some((s,i)=>s!==state.symbols[i])){state.symbols=[...new Set(normalized)];saveSymbols();renderWatchlist();}
    if(state.focusSymbol)state.focusSymbol=(await resolveSymbols([state.focusSymbol]))[0];
    const displaySymbols=[...new Set([...state.symbols,...(state.focusSymbol?[state.focusSymbol]:[])])];
    const [dailyResult,intradayResult,signalResult]=await Promise.all([
      fetchMarket(displaySymbols,"1Day").then(value=>({status:"fulfilled",value}),reason=>({status:"rejected",reason})),
      fetchMarket(displaySymbols,"5Min").then(value=>({status:"fulfilled",value}),reason=>({status:"rejected",reason})),
      fetchSignals(displaySymbols).then(value=>({status:"fulfilled",value}),reason=>({status:"rejected",reason}))
    ]);
    if(dailyResult.status!=="fulfilled")throw dailyResult.reason;
    const dailyMarket=dailyResult.value||{},intradayMarket=intradayResult.status==="fulfilled"?(intradayResult.value||{}):{},signals=signalResult.status==="fulfilled"?(signalResult.value||{}):{};
    state.market=dailyMarket;
    for(const symbol of displaySymbols){
      if(!state.market[symbol])continue;
      if(signals[symbol])state.market[symbol].signal=signals[symbol];
      state.market[symbol].intradayBars=intradayMarket[symbol]?.bars||[];
    }
    renderMarketCards(displaySymbols,state.market);
    state.symbols.forEach(s=>{if(state.market[s])maybeNotify(s,state.market[s]);});
    const count=Object.values(state.market).reduce((n,x)=>n+(x.bars||[]).length,0);
    const chartFallback=intradayResult.status!=="fulfilled";
    const signalFallback=signalResult.status!=="fulfilled";
    setStatus("เชื่อมต่อแล้ว · Alpaca IEX (สหรัฐฯ) + DataCedar (หุ้นไทย)"+(chartFallback?" · ใช้กราฟรายวันสำรอง":"")+(signalFallback?" · คำนวณสถานะจากข้อมูลราคา":""),true);
    $("#updated").textContent="อัปเดต "+new Date().toLocaleString("th-TH")+" · ข้อมูลย้อนหลัง "+count+" แท่ง";
  }catch(e){setStatus("เชื่อมต่อไม่สำเร็จ");$("#usCards").innerHTML='<article class="stock-card"><b>โหลดข้อมูลหุ้นสหรัฐฯ ไม่สำเร็จ</b><p>'+escapeHtml(e.message)+'</p></article>';$("#thaiCards").innerHTML='<article class="stock-card"><b>โหลดข้อมูลหุ้นไทยไม่สำเร็จ</b><p>'+escapeHtml(e.message)+'</p></article>';}
  finally{state.busy=false;$("#refresh").disabled=false;$("#refresh").textContent="↻ อัปเดต";}
}
async function addSymbol(symbol){
  symbol=String(symbol||"").trim().toUpperCase();
  symbol=(await resolveSymbols([symbol]))[0];
  if(!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)){setStatus("Ticker ไม่ถูกต้อง");return;}
  if(state.symbols.includes(symbol)){setStatus(symbol+" อยู่ในรายการแล้ว",true);return;}
  if(state.symbols.length>=50){setStatus("ครบจำนวนสูงสุด 50 หุ้นแล้ว");return;}
  try {
    if(!state.shared)throw new Error("กรุณาเชื่อมบัญชี LINE ก่อนเพิ่มหุ้น เพื่อให้ Watchlist บนเว็บและ LINE เป็นรายการเดียวกัน");
    const data=await apiRequest("/api/watchlist/add",{method:"POST",body:JSON.stringify({symbol})});
    state.symbols=data.symbols||state.symbols;
    saveSymbols();
    renderWatchlist();
    $("#searchResults").innerHTML="";$("#stockSearch").value="";
    loadMarket();
  } catch(e) {setStatus("เพิ่มหุ้นไม่สำเร็จ: "+e.message);}
}
async function searchAssets(){
  const q=$("#stockSearch").value.trim();if(!q)return;
  const root=$("#searchResults");root.textContent="กำลังค้นหาหุ้นสหรัฐฯ และหุ้นไทย…";
  try{
    const response=await fetch(state.apiUrl.replace(/\/$/,"")+"/api/assets?q="+encodeURIComponent(q),{cache:"no-store"});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"ค้นหาไม่สำเร็จ");
    state.assets=data.assets||[];state.assetNames=state.assetNames||{};state.assets.forEach(a=>{state.assetNames[a.symbol]=a.name;});
    root.innerHTML=state.assets.length?state.assets.map(a=>'<button class="search-result" type="button" data-symbol="'+escapeHtml(a.symbol.replace(/\.BK$/,""))+(a.market==="THAI"?".BK":'')+'"><b>'+escapeHtml(a.symbol.replace(/\.BK$/i,""))+'</b><span>'+escapeHtml(a.name)+'</span><small>'+(a.market==="THAI"?"หุ้นไทย · "+escapeHtml(a.exchange):"หุ้นสหรัฐฯ · "+escapeHtml(a.exchange))+' · เพิ่ม +</small></button>').join(""):"ไม่พบหุ้นที่ตรงกัน";
  }catch(e){root.textContent="ค้นหาไม่สำเร็จ: "+e.message;}
}
let screenerRanked=[],screenerPage=1;
function renderScreenerPage(){
  const root=$("#screenerResults"),pageSize=10,total=screenerRanked.length,pages=Math.max(1,Math.ceil(total/pageSize));
  screenerPage=Math.min(Math.max(1,screenerPage),pages);
  const shown=screenerRanked.slice((screenerPage-1)*pageSize,screenerPage*pageSize);
  const header='<div class="screener-summary">พบ '+total+' หุ้น · แสดงอันดับ '+((screenerPage-1)*pageSize+1)+'–'+Math.min(screenerPage*pageSize,total)+' จาก '+total+' หุ้น · สแกนได้ '+(window.screenerScannedCount||0)+' หุ้น</div>';
  const rows=shown.map((x,i)=>{
    const already=state.symbols.includes(x.symbol);
    const label=x.status==="buy"?"แนวโน้มผ่านเงื่อนไข":x.status==="risk"?"แนวโน้มอ่อน":"รอการยืนยัน";
    return '<div class="rank-row"><b>#'+((screenerPage-1)*pageSize+i+1)+' '+escapeHtml(x.symbol)+'</b><span class="signal '+(x.status==="buy"?"buy":x.status==="risk"?"risk":"wait")+'">'+label+'</span><span>'+Number(x.score||0)+'/5</span><button type="button" data-screener-add="'+escapeHtml(x.symbol)+'" '+(already?'disabled':'')+'>'+(already?'อยู่ในรายการแล้ว':'เพิ่มใน LINE + เว็บ')+'</button></div>';
  }).join("");
  const pager=pages>1?'<div class="screener-pager"><button type="button" data-screener-page="'+(screenerPage-1)+'" '+(screenerPage===1?'disabled':'')+'>หน้าก่อน</button><span>หน้า '+screenerPage+' / '+pages+'</span><button type="button" data-screener-page="'+(screenerPage+1)+'" '+(screenerPage===pages?'disabled':'')+'>หน้าถัดไป</button></div>':"";
  root.innerHTML=header+(rows||'<div class="screener-empty">ไม่พบหุ้นที่มีข้อมูลย้อนหลังเพียงพอ</div>')+pager;
}
async function runScreener(){
  const btn=$("#runScreener"),root=$("#screenerResults");
  btn.disabled=true;btn.textContent="กำลังคัดกรอง…";
  root.textContent="กำลังคัดกรองหุ้นสหรัฐฯ และคำนวณ EMA20/50, RSI14, MACD และ ADX14…";
  try{
    const data=await apiRequest("/api/screener");
    screenerRanked=data.ideas||[];
    screenerPage=1;
    window.screenerScannedCount=Number(data.scannedCount||0);
    renderScreenerPage();
  }catch(e){root.textContent="คัดกรองไม่สำเร็จ: "+e.message;}
  finally{btn.disabled=false;btn.textContent="คัดกรองอีกครั้ง";}
}
$("#apiUrl").value=state.apiUrl;
$("#refresh").addEventListener("click",loadMarket);
$("#timeframe").value="1Day";
$("#timeframe").disabled=true;
$("#saveUrl").addEventListener("click",()=>{
  const value=$("#apiUrl").value.trim().replace(/\/$/,"");
  try{new URL(value);state.apiUrl=value;localStorage.setItem("stockWatcherApiUrl",value);setStatus("บันทึก Worker URL แล้ว",true);loadMarket();}
  catch{setStatus("Worker URL ไม่ถูกต้อง");}
});
$("#addStock").addEventListener("click",searchAssets);
$("#stockSearch").addEventListener("keydown",e=>{if(e.key==="Enter")searchAssets();});
$("#searchResults").addEventListener("click",e=>{const b=e.target.closest("[data-symbol]");if(b)addSymbol(b.dataset.symbol);});
$("#usCards").addEventListener("click",e=>{
  const b=e.target.closest("[data-remove]");if(!b)return;
  removeSymbol(b.dataset.remove);
});
$("#thaiCards").addEventListener("click",e=>{const b=e.target.closest("[data-remove]");if(b)removeSymbol(b.dataset.remove);});
$("#runScreener").addEventListener("click",runScreener);
$("#screenerResults").addEventListener("click",e=>{const add=e.target.closest("[data-screener-add]");if(add){addSymbol(add.dataset.screenerAdd);return;}const page=e.target.closest("[data-screener-page]");if(page){screenerPage=Number(page.dataset.screenerPage);renderScreenerPage();}});
$("#enableAlerts").addEventListener("click",async()=>{
  if(!("Notification" in window)){setStatus("เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน");return;}
  const permission=await Notification.requestPermission();
  setStatus(permission==="granted"?"เปิดการแจ้งเตือนแล้ว":"ยังไม่ได้อนุญาตการแจ้งเตือน",permission==="granted");
});
renderWatchlist();initializeAccount();


/* Live price polling: Alpaca IEX latest trades every 15 seconds during US regular hours. */
setInterval(refreshLiveQuotes,15000);
setInterval(updateMarketStatus,30000);
updateMarketStatus();
setInterval(refreshIntradayBars,60000);
setInterval(syncSharedWatchlist,3000);
window.addEventListener("focus",()=>syncSharedWatchlist());
document.addEventListener("visibilitychange",()=>{if(!document.hidden)syncSharedWatchlist();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshLiveQuotes();});
