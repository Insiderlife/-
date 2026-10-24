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
 const people=['илон маск','маск','elon musk','musk','дженсен хуанг','jensen huang','безос','bezos','цукерберг','zuckerberg','гейтс','gates','альтман','altman','баффет','buffett','дуров','durov'];
 const forward=['будущ','измен','прорыв','созда','запуст','планир','постро','изобрел','изобрет','успех','достиж','новый','впервые','професси','технолог','космос','робот','мотивац','предприним','future','build','launch','innovation','breakthrough','robot','space','startup'];
 const political=['выбор','голосован','конгресс','партия','парламент','дипломат','санкц','военный','война','министр','election','campaign','senate','congress','war','military','sanctions'];
 const future=forward.some(k=>t.includes(k));
 const politic=political.some(k=>t.includes(k));
 const personalBonus=people.some(k=>t.includes(k))?(future?24:6):0;
 const motivationBonus=forward.reduce((n,k)=>n+(t.includes(k)?5:0),0);
 const nichePenalty=(niche.some(k=>t.includes(k))?28:0)+(politic&&!future?55:politic?16:0);
 const engagement=x.views===null||x.views===undefined?0:Math.min(22,Math.log10(Math.max(1,x.views))*3);
 return Math.max(0,Math.min(95,Math.round(12+Math.min(22,broadPoints)+Math.min(25,hookPoints)+Math.min(18,motivationBonus)+personalBonus+engagement-nichePenalty)));
}
function unpackText(html){
 return strip(String(html||'').replace(/<br\s*\/?>/gi,' ').replace(/<\/p>/gi,' ').replace(/<[^>]+>/g,' ')).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
}
function parseViews(raw){
 const m=String(raw||'').replace(/\s/g,'').match(/(\d+(?:[.,]\d+)?)([KMBКМ])?/i);
 if(!m)return null;
 const unit=(m[2]||'').toUpperCase();
 return Math.round(Number(m[1].replace(',','.'))*({'K':1000,'К':1000,'M':1000000,'М':1000000,'B':1000000000}[unit]||1));
}
async function sources(){
 const channels=(env.MONITOR_CHANNELS||'rian_ru,breakingmash,banksta').split(',').map(x=>x.trim().replace(/^@/,'')).filter(x=>/^[a-zA-Z0-9_]{5,32}$/.test(x)).slice(0,20);
 const requests=await Promise.allSettled(channels.map(async channel=>{
  const response=await fetch('https://t.me/s/'+channel,{headers:{'user-agent':'Mozilla/5.0 (compatible; Viral2030Bot/1.0)'},signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error(channel+' HTTP '+response.status);
  const html=await response.text();
  const segments=html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  const entries=[];
  for(const segment of segments){
   const id=(segment.match(/data-post="([^"]+)"/)||[])[1];
   const textHtml=(segment.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)||[])[1];
   const words=unpackText(textHtml);
   const viewsText=(segment.match(/<span class="tgme_widget_message_views">([^<]+)<\/span>/)||[])[1];
   const timestamp=(segment.match(/<time[^>]*datetime="([^"]+)"/)||[])[1];
   const age=timestamp?Date.now()-new Date(timestamp).getTime():0;
   if(!id||!words||words.length<65||!/[А-Яа-яЁё]/.test(words)||age>48*3600000)continue;
   const title=words.slice(0,210).trim();
   const views=parseViews(viewsText);
   entries.push({id:'tg'+id.replace(/[^a-z0-9_]/ig,'_'),title,fullText:words.slice(0,2400),url:'https://t.me/'+id,comments:null,points:null,views,source:'@'+channel});
  }
  console.log('CHANNEL '+channel+' posts '+entries.length);
  return entries.slice(-15);
 }));
 const items=[];
 for(const result of requests){if(result.status==='fulfilled')items.push(...result.value);else console.error('CHANNEL ERROR',String(result.reason));}
 return items;
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
function isPolitical(item){
 const t=((item.fullText||'')+' '+(item.title||'')).toLowerCase();
 const patterns=[/политик/,/выбор(ы|ов|ах|ный)/,/президент/,/трамп/,/путин/,/зеленск/,/депутат/,/министр/,/правительств/,/госдум/,/парламент/,/санкци/,/военн/,/войн/,/фронт/,/боев(ые|ых|ой)/,/геополит/,/дипломат/,/переговор(ы|ов)/,/нато/,/украин/,/конгресс/,/белый дом/,/кремл/,/госдеп/,/губернатор/,/мэр /,/законопроект/,/партия/,/митинг/,/протест/,/тарифы сша/,/госбюджет/];
 return patterns.some(pattern=>pattern.test(t));
}
async function scan(){
 if(scanBusy||!token||!owner)return;
 scanBusy=true;
 try{
  const fetched=await sources();
  const fresh=fetched.filter(x=>!sent.has(x.id));
  const safe=fresh.filter(x=>!isPolitical(x));
  const candidates=safe.map(x=>({...x,rank:score(x)})).sort((a,b)=>b.rank-a.rank).slice(0,limit);
  console.log('SCAN STATS fetched='+fetched.length+' fresh='+fresh.length+' nonpolitical='+safe.length+' candidates='+candidates.length);
  let delivered=0;
  for(const x of candidates){
   const ruTitle=await russianHeadline(x);
   if(!ruTitle||!/[А-Яа-яЁё]/.test(ruTitle)){console.log('Skipping untranslated headline',x.id);continue;}
   x.titleRu=ruTitle;
   sent.add(x.id);news.set(x.id,x);
   const metrics=x.views!==null?'Просмотры: '+x.views.toLocaleString('ru-RU'):'Данные о просмотрах недоступны';
   await telegram('sendMessage',{chat_id:owner,parse_mode:'HTML',disable_web_page_preview:true,text:'🔥 <b>'+esc(x.titleRu)+'</b>\n\nИсточник: '+esc(x.source)+'\n'+esc(metrics)+'\nОценка массового интереса (прогноз, не факт вирусности): '+x.rank+'/100\n'+esc(x.url),reply_markup:{inline_keyboard:[[{text:'🎬 Создать сценарий',callback_data:'reel:'+x.id},{text:'Пропустить',callback_data:'skip:'+x.id}]]}});
   delivered++;
  }
  console.log('SCAN SENT '+delivered);
  if(sent.size>1500){sent.clear();news.clear();}
 }catch(e){console.error('SCAN',e);}finally{scanBusy=false;}
}
async function scenario(x){
 if(!aiKey) return 'Не задан OPENAI_API_KEY в Render → Environment.';
 const messages=[
 {role:'system',content:'Вы — редактор ВИРУСНЫХ коротких роликов для самой широкой аудитории (не только инвесторов и айтишников) личного канала «Подготовка к 2030 году и добыча нефти XXI века». Напишите ОДИН разговорный сценарий Reels на русском языке строго на 20–30 секунд, 50–70 слов. Один тейк, без ремарок, заголовков, пунктов, эмодзи, указаний монтажа. Структура: 1) сильный честный триггерный хук; 2) раскрытие конкретной новости и польза; 3) очень короткая и естественная связь с подготовкой к 2030 году или поиском нефти XXI века (новые возможности), но без натянутой аналогии; 4) призыв подписаться. Сюжет и тон — вдохновляющие перемены, развитие, движение вперёд, достижения, новые возможности, известные личности. Не включай политические темы, политиков, выборы, войны или геополитику. Тематика только будущее, мотивация, технологии, бизнес, достижения. Избегайте узкого профессионального жаргона, делайте сюжет понятным любому человеку. Не выдумывайте цифры и цитаты и не делайте категорических выводов из одного заголовка. Если деталей недостаточно, говорите осторожно.'},
 {role:'user',content:'Источник: '+x.source+'\nНовость на русском: '+(x.titleRu||x.title)+'\nСсылка: '+x.url+'\nПолный текст: '+(x.fullText||x.title)+'\nКомментарии: '+(x.comments??'нет данных')+'\nСценарий напишите исключительно по-русски, включая все пояснения.'}
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
