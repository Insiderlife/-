import http from 'node:http';
import crypto from 'node:crypto';

const env = process.env;
const token=env.TELEGRAM_BOT_TOKEN||'';
const owner=env.OWNER_CHAT_ID||'';
const aiKey=env.OPENAI_API_KEY||'';
const secret=env.TELEGRAM_WEBHOOK_SECRET||'';
const publicUrl=(env.PUBLIC_URL||'').replace(/\/$/,'');
const port=Number(env.PORT||10000);
const interval=Math.max(15,Number(env.SCAN_INTERVAL_MINUTES||60))*60000;
const sent=new Set();
const news=new Map();
let scanBusy=false;
const limit=Number(env.MAX_PER_SCAN||3);
const urlBase='https://api.telegram.org/bot'+token+'/';

async function telegram(method,body){
 if(!token) return;
 const response=await fetch(urlBase+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 if(!response.ok) throw new Error('Telegram '+response.status+': '+(await response.text()).slice(0,200));
 return response.json();
}
function strip(x){return String(x||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
function esc(x){return String(x||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function score(x){
 const t=(x.title||'').toLowerCase();
 const broad=['зарплат','пенси','цены','подорож','подешев','миллион','миллиард','работ','увольнен','доход','квартир','налог','запрет','закон','образован','школ','медици','здоров','робот','искусствен','професси','путешеств','богат','бедн','неожидан','скандал','рекорд','технолог','семь','дет','общество','интернет','jobs','money','future','wealth','housing','robot','ai ','ban ','education'];
 const niche=['github','programming','javascript','software release','api update','kernel','compiler','database'];
 const hooks=['впервые','запрет','рекорд','угрожа','замен','обогат','массов','скандал','почему','неожидан','миллион','будущ','вместо','подорож','налог','прорыв','увольнен','взрыв','опасн'];
 const broadPoints=broad.reduce((n,k)=>n+(t.includes(k)?9:0),0);
 const hookPoints=hooks.reduce((n,k)=>n+(t.includes(k)?8:0),0);
 const nichePenalty=niche.some(k=>t.includes(k))?28:0;
 const engagement=x.comments===null?0:Math.min(28,Math.log1p(x.comments)*5)+Math.min(12,Math.log1p(x.points||0)*2);
 return Math.max(0,Math.min(100,Math.round(12+Math.min(43,broadPoints)+Math.min(25,hookPoints)+engagement-nichePenalty)));
}
async function sources(){
 const items=[];
 const ids=await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json();
 const samples=await Promise.all(ids.slice(0,25).map(async id=>{
  try {const r=await fetch('https://hacker-news.firebaseio.com/v0/item/'+id+'.json');return r.json();}catch{return null;}
 }));
 for(const i of samples) if(i&&i.title&&i.url) items.push({id:'hn'+i.id,title:i.title,url:i.url,comments:i.descendants||0,points:i.score||0,source:'Hacker News'});
 const queries=[
 'самые обсуждаемые новости сегодня общество деньги работа',
 'новости цены зарплаты пенсии налоги',
 'новости запреты законы изменения жизнь людей',
 'новости неожиданные события рекорды скандалы',
 'искусственный интеллект заменяет профессии',
 'технологии изменения жизни людей',
 'богатство бизнес новые возможности заработка',
 'демография образование здоровье будущее'
 ];
 for(const q of queries){
  try {
   const r=await fetch('https://news.google.com/rss/search?q='+encodeURIComponent(q)+'&hl=ru&gl=RU&ceid=RU:ru');
   const xml=await r.text();
   for(const block of (xml.match(/<item>[\s\S]*?<\/item>/g)||[]).slice(0,12)){
    const title=strip((block.match(/<title>([\s\S]*?)<\/title>/)||[])[1]).replace(/<!\[CDATA\[|\]\]>/g,'');
    const link=strip((block.match(/<link>([\s\S]*?)<\/link>/)||[])[1]);
    if(title&&link)items.push({id:crypto.createHash('sha256').update(link).digest('hex').slice(0,20),title,url:link,source:'Google News',comments:null,points:null});
   }
  }catch(e){console.error('RSS:',e.message);}
 }
 return items;
}
async function scan(){
 if(scanBusy||!token||!owner)return;
 scanBusy=true;
 try{
  const candidates=(await sources()).filter(x=>!sent.has(x.id)).map(x=>({...x,rank:score(x)})).filter(x=>x.rank>=29).sort((a,b)=>b.rank-a.rank).slice(0,limit);
  for(const x of candidates){
   sent.add(x.id);news.set(x.id,x);
   const metrics=x.comments!==null?'Комментарии: '+x.comments+'; реакции HN: '+x.points:'Публичных показателей комментариев у RSS нет';
   await telegram('sendMessage',{chat_id:owner,parse_mode:'HTML',disable_web_page_preview:true,text:'🔥 <b>'+esc(x.title)+'</b>\n\nИсточник: '+esc(x.source)+'\n'+esc(metrics)+'\nОценка массового интереса (прогноз, не факт вирусности): '+x.rank+'/100\n'+esc(x.url),reply_markup:{inline_keyboard:[[{text:'🎬 Сделать Reels',callback_data:'reel:'+x.id},{text:'Пропустить',callback_data:'skip:'+x.id}]]}});
  }
  if(sent.size>1500){sent.clear();news.clear();}
 }catch(e){console.error('SCAN',e);}finally{scanBusy=false;}
}
async function scenario(x){
 if(!aiKey) return 'Не задан OPENAI_API_KEY в Render → Environment.';
 const messages=[
 {role:'system',content:'Вы — редактор ВИРУСНЫХ коротких роликов для самой широкой аудитории (не только инвесторов и айтишников) личного канала «Подготовка к 2030 году и добыча нефти XXI века». Напишите ОДИН разговорный сценарий Reels на русском языке строго на 20–30 секунд, 50–70 слов. Один тейк, без ремарок, заголовков, пунктов, эмодзи, указаний монтажа. Структура: 1) сильный честный триггерный хук; 2) раскрытие конкретной новости и польза; 3) очень короткая и естественная связь с подготовкой к 2030 году или поиском нефти XXI века (новые возможности), но без натянутой аналогии; 4) призыв подписаться. Избегайте узкого профессионального жаргона, делайте сюжет понятным любому человеку. Не выдумывайте цифры и цитаты и не делайте категорических выводов из одного заголовка. Если деталей недостаточно, говорите осторожно.'},
 {role:'user',content:'Источник: '+x.source+'\nНовость: '+x.title+'\nСсылка: '+x.url+'\nКомментарии: '+(x.comments??'нет данных')+'\nНапишите сценарий.'}
 ];
 const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+aiKey,'content-type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL||'gpt-4.1-mini',messages,temperature:0.8,max_tokens:240})});
 if(!r.ok)throw new Error('OpenAI '+r.status+': '+(await r.text()).slice(0,250));
 const j=await r.json();return j.choices?.[0]?.message?.content?.trim()||'Не удалось получить сценарий.';
}
async function incoming(update){
 const message=update.message;
 if(message){
  const chat=String(message.chat?.id||'');
  if(message.text==='/start'){
   if(owner&&chat!==owner)return;
   await telegram('sendMessage',{chat_id:chat,text:'Бот 2030 запущен. Ваш Telegram Chat ID: '+chat+'\n/scan — проверить новости сейчас.'});
  }
  if(message.text==='/scan'&&chat===owner){await telegram('sendMessage',{chat_id:chat,text:'Ищу актуальные новости…'});await scan();}
 }
 const q=update.callback_query;
 if(q){
  const chat=String(q.message?.chat?.id||'');
  await telegram('answerCallbackQuery',{callback_query_id:q.id});
  if(chat!==owner)return;
  const [action,id]=String(q.data||'').split(':');
  if(action==='skip'){await telegram('sendMessage',{chat_id:chat,text:'Пропущено.'});return;}
  const x=news.get(id);
  if(!x){await telegram('sendMessage',{chat_id:chat,text:'Новость не сохранилась после перезапуска. Дождитесь новой подборки.'});return;}
  try{const s=await scenario(x);await telegram('sendMessage',{chat_id:chat,text:'🎬 Сценарий Reels\n\n'+s+'\n\nИсточник: '+x.url,disable_web_page_preview:true});}
  catch(e){await telegram('sendMessage',{chat_id:chat,text:'Ошибка генерации: '+e.message});}
 }
}
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({name:'2030 Viral Reels Bot',ready:!!(token&&owner&&aiKey&&publicUrl&&secret)}));return;}
 if(req.method==='POST'&&req.url==='/telegram/'+secret&&secret){
  if(req.headers['x-telegram-bot-api-secret-token']!==secret){res.writeHead(403);res.end('Forbidden');return;}
  let body='';for await(const part of req){body+=part;if(body.length>200000){res.writeHead(413);res.end();return;}}
  res.writeHead(200);res.end('OK');
  try{await incoming(JSON.parse(body));}catch(e){console.error('WEBHOOK',e);}
  return;
 }
 res.writeHead(404);res.end('Not found');
});
server.listen(port,'0.0.0.0',async()=>{
 console.log('Viral2030 listening on '+port);
 if(token&&publicUrl&&secret){
  try{await telegram('setWebhook',{url:publicUrl+'/telegram/'+secret,secret_token:secret,drop_pending_updates:false});console.log('Webhook configured');}catch(e){console.error('Webhook setup:',e);}
 }
 if(token&&owner)setTimeout(scan,10000);
});
setInterval(scan,interval);
