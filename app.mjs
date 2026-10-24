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
 const people=['илон маск','маск','elon musk','musk','трамп','trump','дженсен хуанг','jensen huang','безос','bezos','цукерберг','zuckerberg','гейтс','gates','альтман','altman','баффет','buffett','дуров','durov'];
 const forward=['будущ','измен','прорыв','созда','запуст','планир','постро','изобрел','изобрет','успех','достиж','новый','впервые','професси','технолог','космос','робот','мотивац','предприним','future','build','launch','innovation','breakthrough','robot','space','startup'];
 const political=['выбор','голосован','конгресс','партия','парламент','дипломат','санкц','военный','война','министр','election','campaign','senate','congress','war','military','sanctions'];
 const future=forward.some(k=>t.includes(k));
 const politic=political.some(k=>t.includes(k));
 const personalBonus=people.some(k=>t.includes(k))?(future?24:6):0;
 const motivationBonus=forward.reduce((n,k)=>n+(t.includes(k)?5:0),0);
 const nichePenalty=(niche.some(k=>t.includes(k))?28:0)+(politic&&!future?55:politic?16:0);
 const engagement=x.comments===null?0:Math.min(28,Math.log1p(x.comments)*5)+Math.min(12,Math.log1p(x.points||0)*2);
 return Math.max(0,Math.min(95,Math.round(12+Math.min(22,broadPoints)+Math.min(25,hookPoints)+Math.min(18,motivationBonus)+personalBonus+engagement-nichePenalty)));
}
async function sources(){
 const items=[];
 const queries=[
 'site:rbc.ru технологии будущее Маск',
 'site:tass.ru технологии робот будущего',
 'site:ria.ru открытия технологии будущее',
 'site:forbes.ru предприниматели успех технологии',
 'site:vc.ru новые технологии предприниматель',
 'site:pikabu.ru необычные открытия технологии',
 'site:ixbt.com робот Маск технологии',
 'site:hi-tech.mail.ru технологии открытие',
 'site:lenta.ru технологии общество будущее',
 'site:rg.ru профессии будущее технологии'
 ];
 const feeds=await Promise.allSettled(queries.map(async q=>{
  const response=await fetch('https://news.google.com/rss/search?q='+encodeURIComponent(q+' when:3d')+'&hl=ru&gl=RU&ceid=RU:ru',{signal:AbortSignal.timeout(12000)});
  if(!response.ok)return [];
  const xml=await response.text(),rows=[];
  for(const block of (xml.match(/<item>[\s\S]*?<\/item>/g)||[]).slice(0,12)){
   const title=strip((block.match(/<title>([\s\S]*?)<\/title>/)||[])[1]);
   const url=strip((block.match(/<link>([\s\S]*?)<\/link>/)||[])[1]);
   if(title&&url&&/[А-Яа-яЁё]/.test(title))rows.push({id:crypto.createHash('sha256').update(url).digest('hex').slice(0,20),title,url,comments:null,points:null,source:'Российские СМИ'});
  }
  return rows;
 }));
 for(const result of feeds)if(result.status==='fulfilled')items.push(...result.value);
 return [...new Map(items.map(x=>[x.id,x])).values()];
}
async function russianHeadline(x){
 const title=String(x.title||'').trim();
 if(!title)return '';
 if(!/[A-Za-z]/.test(title) || (!aiKey && /[А-Яа-яЁё]/.test(title)))return title;
 if(!aiKey)return /[А-Яа-яЁё]/.test(title)?title:null;
 const messages=[
  {role:'system',content:'Переведи новостной заголовок на грамотный естественный русский язык для широкой аудитории. Верни только русский заголовок без комментариев, кавычек и форматирования. Названия брендов и имена можно передавать принятыми русскими написаниями. Не добавляй факты и не преувеличивай смысл.'},
  {role:'user',content:title}
 ];
 try{
  const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+aiKey,'content-type':'application/json'},body:JSON.stringify({model:env.OPENAI_MODEL||'gpt-4.1-mini',messages,temperature:0,max_tokens:130})});
  if(!r.ok)throw new Error('Перевод: '+r.status);
  const j=await r.json();const result=j.choices?.[0]?.message?.content?.trim();
  return result&&/[А-Яа-яЁё]/.test(result)?result:null;
 }catch(e){console.error('TRANSLATE',e.message);return /[А-Яа-яЁё]/.test(title)?title:null;}
}
async function scan(){
 if(scanBusy||!token||!owner)return;
 scanBusy=true;
 try{
  const candidates=(await sources()).filter(x=>!sent.has(x.id)).map(x=>({...x,rank:score(x)})).filter(x=>x.rank>=29).sort((a,b)=>b.rank-a.rank).slice(0,limit);
  for(const x of candidates){
   const ruTitle=await russianHeadline(x);
   if(!ruTitle||!/[А-Яа-яЁё]/.test(ruTitle)){console.log('Skipping untranslated headline',x.id);continue;}
   x.titleRu=ruTitle;
   sent.add(x.id);news.set(x.id,x);
   const metrics=x.comments!==null?'Комментарии: '+x.comments+'; реакции HN: '+x.points:'Публичных показателей комментариев у RSS нет';
   await telegram('sendMessage',{chat_id:owner,parse_mode:'HTML',disable_web_page_preview:true,text:'🔥 <b>'+esc(x.titleRu)+'</b>\n\nИсточник: '+esc(x.source)+'\n'+esc(metrics)+'\nОценка массового интереса (прогноз, не факт вирусности): '+x.rank+'/100\n'+esc(x.url),reply_markup:{inline_keyboard:[[{text:'🎬 Создать сценарий',callback_data:'reel:'+x.id},{text:'Пропустить',callback_data:'skip:'+x.id}]]}});
  }
  if(sent.size>1500){sent.clear();news.clear();}
 }catch(e){console.error('SCAN',e);}finally{scanBusy=false;}
}
async function scenario(x){
 if(!aiKey) return 'Не задан OPENAI_API_KEY в Render → Environment.';
 const messages=[
 {role:'system',content:'Вы — редактор ВИРУСНЫХ коротких роликов для самой широкой аудитории (не только инвесторов и айтишников) личного канала «Подготовка к 2030 году и добыча нефти XXI века». Напишите ОДИН разговорный сценарий Reels на русском языке строго на 20–30 секунд, 50–70 слов. Один тейк, без ремарок, заголовков, пунктов, эмодзи, указаний монтажа. Структура: 1) сильный честный триггерный хук; 2) раскрытие конкретной новости и польза; 3) очень короткая и естественная связь с подготовкой к 2030 году или поиском нефти XXI века (новые возможности), но без натянутой аналогии; 4) призыв подписаться. Сюжет и тон — вдохновляющие перемены, развитие, движение вперёд, достижения, новые возможности, известные личности. Политику не обсуждать, кроме прямого влияния события на будущее или технологии. Избегайте узкого профессионального жаргона, делайте сюжет понятным любому человеку. Не выдумывайте цифры и цитаты и не делайте категорических выводов из одного заголовка. Если деталей недостаточно, говорите осторожно.'},
 {role:'user',content:'Источник: '+x.source+'\nНовость на русском: '+(x.titleRu||x.title)+'\nСсылка: '+x.url+'\nКомментарии: '+(x.comments??'нет данных')+'\nСценарий напишите исключительно по-русски, включая все пояснения.''}
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
  try{const s=await scenario(x);await telegram('sendMessage',{chat_id:chat,text:'🎬 Сценарий ролика\n\n'+s+'\n\nИсточник: '+x.url,disable_web_page_preview:true});}
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
