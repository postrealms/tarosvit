"use strict";
/* Таросвіт — PWA client. A reading runs on /api/analyze (the Claude API key stays on the server).
   History lives on this device; with an account it is kept in Supabase and follows the user between devices. */

/* Supabase project (the publishable key is public by design; data is protected by row-level security).
   Leave both empty to run without accounts. */
const SB = {
  url: "https://ubiqwtfigenqyqmlfafd.supabase.co",
  key: "sb_publishable_61FCnviB1lgNJl1J2YHSuw_bAoK_FSg",
};
const VERSION = "0.1.2";
const accountsOn = !!(SB.url && SB.key);

const $ = id => document.getElementById(id);
const ls = {
  get(k){ try{ return localStorage.getItem(k); }catch{ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); return true; }catch{ return false; } },
  del(k){ try{ localStorage.removeItem(k); }catch{} }
};

const video = $("video"), stage = $("stage"), frame = $("frame");
let view = "camera", returnView = "camera";
let stream = null, starting = false, ctrl = null, shotUrl = null;
let current = null;          // the reading on screen, when it is a saved one
let pending = null;          // a photo taken before sign-in, read right after it
let authRequired = false, usage = null;

/* ---------- views ---------- */
function show(v){
  view = v;
  for(const id of ["reading", "history", "account"]) $(id).hidden = v !== id;
  const cam = v === "camera";
  stage.hidden = !cam; $("controls").hidden = !cam;
  cam ? startCamera() : stopCamera();
}

/* ---------- camera ---------- */
async function startCamera(){
  if(stream || starting || !navigator.mediaDevices?.getUserMedia) return;
  starting = true;
  try{
    const s = await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{facingMode:{ideal:"environment"}, width:{ideal:1920}, height:{ideal:1080}}
    });
    if(view !== "camera" || document.hidden){ s.getTracks().forEach(t => t.stop()); return; }
    stream = s; video.srcObject = s; video.hidden = false;
    await video.play().catch(()=>{});
    document.body.classList.add("live");
  }catch{ stream = null; }   // no permission or no camera: the shutter opens the phone's own camera instead
  finally{ starting = false; }
}
function stopCamera(){
  if(!stream) return;
  stream.getTracks().forEach(t => t.stop());
  stream = null; video.srcObject = null; video.hidden = true;
  document.body.classList.remove("live");
}
document.addEventListener("visibilitychange", () => {
  if(document.hidden) stopCamera(); else if(view === "camera") startCamera();
});

const toBlob = canvas => new Promise(r => canvas.toBlob(r, "image/jpeg", .86));

/* Crop the live frame to the card outline (plus a small margin), accounting for object-fit: cover. */
async function captureLive(){
  const vw = video.videoWidth, vh = video.videoHeight;
  if(!vw || !vh) return null;
  const s = stage.getBoundingClientRect(), f = frame.getBoundingClientRect();
  const scale = Math.max(s.width / vw, s.height / vh);
  const offX = (vw * scale - s.width) / 2, offY = (vh * scale - s.height) / 2;
  const m = f.width * .08;
  let sx = (f.left - s.left - m + offX) / scale, sy = (f.top - s.top - m + offY) / scale;
  let sw = (f.width + 2*m) / scale, sh = (f.height + 2*m) / scale;
  sx = Math.max(0, sx); sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  const k = Math.min(1, 1400 / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return toBlob(c);
}

function loadImg(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img); img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}
async function fromFile(file){
  const url = URL.createObjectURL(file);
  try{
    const img = await loadImg(url);
    const k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await toBlob(c);
  }finally{ URL.revokeObjectURL(url); }
}
async function makeThumb(blob){
  const url = URL.createObjectURL(blob);
  try{
    const img = await loadImg(url), c = document.createElement("canvas");
    c.width = 140; c.height = 240;
    const k = Math.max(140 / img.naturalWidth, 240 / img.naturalHeight);
    c.getContext("2d").drawImage(img, (140 - img.naturalWidth*k)/2, (240 - img.naturalHeight*k)/2, img.naturalWidth*k, img.naturalHeight*k);
    return c.toDataURL("image/jpeg", .7);
  }catch{ return ""; }
  finally{ URL.revokeObjectURL(url); }
}
const toBase64 = blob => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(",")[1] || ""); fr.onerror = reject;
  fr.readAsDataURL(blob);
});

/* ---------- server ---------- */
const accessCode = () => ls.get("tarosvit.code") || "";
async function apiHeaders(extra){
  const h = {"x-access-code": accessCode(), ...(extra || {})};
  const tok = session ? await accessToken().catch(() => null) : null;
  if(tok) h.Authorization = "Bearer " + tok;
  return h;
}
async function checkAccess(){
  try{
    const r = await fetch("/api/analyze", {headers: await apiHeaders()});
    const j = await r.json();
    $("gate").hidden = !(j.codeRequired && !j.codeOk);
    authRequired = !!j.authRequired;
    if(authRequired && session && j.signedIn === false){ saveSession(null); onAuthChange(); }
    usage = j.usage || null;
  }catch{ /* offline: let the user try later */ }
  renderAccount();
}
$("gateForm").addEventListener("submit", async e => {
  e.preventDefault();
  ls.set("tarosvit.code", $("gateInput").value.trim());
  await checkAccess();
  if(!$("gate").hidden){ $("gateInput").select(); $("gateInput").setCustomValidity("Код не підійшов"); $("gateInput").reportValidity(); }
});
$("gateInput").addEventListener("input", () => $("gateInput").setCustomValidity(""));

/* ---------- reading ---------- */
function setText(paragraphs, waiting){
  const box = $("text"); box.textContent = "";
  for(const p of paragraphs){ const el = document.createElement("p"); el.textContent = p; box.appendChild(el); }
  if(waiting){ const el = document.createElement("p"); el.className = "wait"; el.textContent = "Читаю карту"; box.appendChild(el); }
}
let delTimer = null;
function resetDel(){ clearTimeout(delTimer); $("del").textContent = "Видалити"; $("del").dataset.armed = ""; }
function paint(e){
  $("shot").src = e.thumb || exampleArt();
  $("cardName").textContent = e.name;
  $("cardPos").textContent = (e.example ? "Приклад · " : "") + (e.pos || "");
  $("asked").hidden = !e.q; $("asked").textContent = e.q ? "Питання: " + e.q : "";
  setText(e.body, false);
  $("del").hidden = !!e.example; resetDel();
}
function openEntry(e){ current = e.example ? null : e; paint(e); show("reading"); $("reading").scrollTop = 0; }
function fail(title, msg){
  current = null;
  $("cardName").textContent = title; $("cardPos").textContent = "";
  setText([msg], false); $("del").hidden = true;
}

const ERR = {
  rate:"Забагато запитів. Зачекайте хвилину і спробуйте ще раз.",
  daily_limit:"На сьогодні ліміт тлумачень вичерпано. Повертайтесь завтра.",
  overloaded:"Сервіс зараз перевантажений. Спробуйте за хвилину.",
  network:"Сервер не зміг зв’язатися з Claude. Спробуйте ще раз.",
  no_credit:"Тлумачення тимчасово недоступні. Спробуйте пізніше.",
  server_config:"Сервер налаштовано не до кінця, тому тлумачення поки не працюють.",
  too_big:"Фото завелике. Спробуйте зняти карту ще раз.",
  bad_image:"Не вдалося обробити це фото. Спробуйте інше.",
  parse:"Відповідь прийшла у незрозумілому вигляді. Спробуйте ще раз.",
};

async function interpret(blob, q){
  if(!blob) return;
  if(q === undefined) q = $("question").value.trim();
  if(authRequired && !session){
    pending = {blob, q};
    return openAccount(accountsOn ? "Щоб отримати тлумачення, увійдіть. Фото збережено, після входу я одразу прочитаю карту."
                                  : "Сервер вимагає вхід, але акаунти в застосунку ще не підключені.");
  }
  if(shotUrl) URL.revokeObjectURL(shotUrl);
  shotUrl = URL.createObjectURL(blob); $("shot").src = shotUrl;
  current = null;
  $("cardName").textContent = "Дивлюсь на карту"; $("cardPos").textContent = "";
  $("asked").hidden = !q; $("asked").textContent = q ? "Питання: " + q : "";
  setText([], true); $("del").hidden = true;
  show("reading"); $("reading").scrollTop = 0;

  ctrl?.abort(); const my = ctrl = new AbortController();
  try{
    const res = await fetch("/api/analyze", {
      method:"POST", signal: my.signal,
      headers: await apiHeaders({"content-type":"application/json"}),
      body: JSON.stringify({image: await toBase64(blob), mediaType:"image/jpeg", question:q})
    });
    const j = await res.json().catch(() => ({}));
    if(my.signal.aborted) return;
    if(j._usage || j.usage){ usage = j._usage || j.usage; renderAccount(); }
    if(!res.ok){
      if(j.code === "signin"){ saveSession(null); await onAuthChange(); pending = {blob, q}; return openAccount("Сесія закінчилась. Увійдіть ще раз, фото збережено."); }
      if(j.code === "code"){ $("gate").hidden = false; show("camera"); return; }
      return fail("Не вдалося прочитати карту", ERR[j.code] || "Сталася помилка. Спробуйте ще раз.");
    }
    if(j.error) return fail("Карту не розпізнано", String(j.error));

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), t: Date.now(),
      name: j.card + (j.card_en ? " (" + j.card_en + ")" : ""),
      pos: j.position === "reversed" ? "Перевернуте положення" : "Пряме положення",
      body: j.paragraphs, q, thumb: await makeThumb(blob), synced:false
    };
    if(my.signal.aborted) return;
    current = entry; paint(entry);
    $("question").value = "";
    const list = loadHist(); list.unshift(entry); storeHist(list);
    syncPending();
  }catch(e){
    if(e?.name === "AbortError") return;
    fail("Немає зв’язку", navigator.onLine ? "Не вдалося звернутися до сервера. Спробуйте ще раз." : "Схоже, немає інтернету. Перевірте з’єднання і спробуйте ще раз.");
  }
}

$("shutter").addEventListener("click", async () => {
  if(stream){ const b = await captureLive(); if(b) return interpret(b); }
  $("fileCam").click();
});
$("pick").addEventListener("click", () => $("fileGal").click());
for(const id of ["fileCam", "fileGal"]){
  $(id).addEventListener("change", async e => {
    const file = e.target.files?.[0]; e.target.value = "";
    if(!file) return;
    try{ interpret(await fromFile(file)); }
    catch{ show("reading"); fail("Фото не відкрилось", "Не вдалося прочитати файл. Спробуйте інше фото."); }
  });
}
$("again").addEventListener("click", () => { ctrl?.abort(); show("camera"); });
$("del").addEventListener("click", async () => {
  const b = $("del");
  if(!current) return;
  if(!b.dataset.armed){
    b.dataset.armed = "1"; b.textContent = "Точно видалити?";
    delTimer = setTimeout(resetDel, 4000); return;
  }
  const e = current; current = null; resetDel();
  storeHist(loadHist().filter(x => x.id !== e.id));
  if(session && e.synced) sb("/rest/v1/readings?id=eq." + encodeURIComponent(e.id), {method:"DELETE"}).catch(()=>{});
  openHistory();
});

/* ---------- history ---------- */
const KEY = "tarosvit.history";
function loadHist(){ try{ return JSON.parse(ls.get(KEY)) || []; }catch{ return []; } }
function storeHist(list){
  list = list.slice(0, 200);
  if(ls.set(KEY, JSON.stringify(list))) return;
  // Storage is full: keep the texts, drop the oldest thumbnails
  ls.set(KEY, JSON.stringify(list.map((e, i) => i < 30 ? e : {...e, thumb:""})));
}

function exampleArt(){
  let pts = "";
  for(let i = 0; i < 16; i++){
    const a = Math.PI * i / 8 - Math.PI / 2, R = i % 2 ? 12 : (i % 4 ? 24 : 36);
    pts += (70 + R * Math.cos(a)).toFixed(1) + "," + (112 + R * Math.sin(a)).toFixed(1) + " ";
  }
  const dots = [[30,60],[110,66],[24,150],[116,158],[44,186],[98,44],[70,180]]
    .map(([x,y]) => `<circle cx="${x}" cy="${y}" r="1.8" fill="#e9dfc6"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 240"><rect width="140" height="240" fill="#1e1a2e"/><rect x="8" y="8" width="124" height="224" rx="6" fill="none" stroke="#e9dfc6" stroke-width="1.2"/><polygon points="${pts}" fill="#d9a25f"/>${dots}<text x="70" y="30" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="#e9dfc6">XVII</text><text x="70" y="220" text-anchor="middle" font-family="Georgia,serif" font-size="12" letter-spacing="3" fill="#e9dfc6">ЗІРКА</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
const EXAMPLE = {
  example:true, name:"Зірка (The Star)", pos:"Пряме положення",
  q:"Чи варто починати власний проєкт цієї зими?",
  body:[
    "Зірка приходить після потрясінь і приносить тишу, в якій знову чути себе. Це карта надії, відновлення і довіри до власного шляху: вода в глечиках не закінчується, бо ви черпаєте з того, що справді ваше.",
    "У прямому положенні й у відповідь на ваше питання вона радше каже «так», але без поспіху. Задум живий і чесний, він народився не зі страху щось втратити, а з бажання творити. Зима підходить для тихого старту: перші кроки, перші люди, які повірять.",
    "Зверніть увагу на ресурс. Не обіцяйте собі дива за місяць, оберіть один маленький крок на цей тиждень і зробіть його відкрито. Зірка підтримує тих, хто не ховає свій задум."
  ]
};

function openHistory(){
  const list = loadHist(), box = $("list"); box.textContent = "";
  $("histNote").textContent = !list.length ? "Тут з’являться карти, які ви сфотографуєте. Поки що ось приклад тлумачення."
    : session ? "Історія збережена у вашому акаунті й доступна на інших пристроях."
    : accountsOn ? "Зараз історія лежить лише на цьому телефоні. Увійдіть, щоб зберегти її в акаунті."
    : "Ваші карти зберігаються лише на цьому пристрої.";
  for(const e of (list.length ? list : [EXAMPLE])){
    const b = document.createElement("button"); b.type = "button"; b.className = "item";
    const img = document.createElement("img"); img.alt = ""; img.src = e.thumb || exampleArt();
    const d = document.createElement("div");
    const n = document.createElement("b"); n.textContent = e.name;
    const m = document.createElement("span");
    if(e.example){ const t = document.createElement("em"); t.textContent = "приклад"; m.appendChild(t); m.append(" · " + e.pos); }
    else m.textContent = new Date(e.t).toLocaleString("uk-UA", {day:"numeric", month:"long", hour:"2-digit", minute:"2-digit"}) + " · " + e.pos;
    d.append(n, m);
    if(e.q){ const q = document.createElement("span"); q.textContent = e.q; d.appendChild(q); }
    b.append(img, d); b.addEventListener("click", () => openEntry(e));
    box.appendChild(b);
  }
  show("history"); $("history").scrollTop = 0;
}
$("openHist").addEventListener("click", openHistory);
$("toHist").addEventListener("click", () => { ctrl?.abort(); openHistory(); });
$("histBack").addEventListener("click", () => show("camera"));

/* ---------- account: Supabase Auth + REST, no SDK ---------- */
let session = null;
try{ session = accountsOn ? JSON.parse(ls.get("tarosvit.session") || "null") : null; }catch{}
function saveSession(s){ session = s; s ? ls.set("tarosvit.session", JSON.stringify(s)) : ls.del("tarosvit.session"); }

async function sbAuth(path, body, token){
  const r = await fetch(SB.url + "/auth/v1/" + path, {
    method:"POST",
    headers:{apikey:SB.key, "content-type":"application/json", ...(token ? {Authorization:"Bearer " + token} : {})},
    body: JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok){ const e = new Error(j.msg || j.error_description || j.message || "auth"); e.status = r.status; e.code = j.error_code || j.code || j.error; throw e; }
  return j;
}
const toSession = (j, user) => ({access_token:j.access_token, refresh_token:j.refresh_token,
  expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: user || {id:j.user?.id, email:j.user?.email}});

let refreshing = null;
async function accessToken(){
  if(!session) return null;
  if(Date.now() < session.expires_at - 60000) return session.access_token;
  refreshing ||= sbAuth("token?grant_type=refresh_token", {refresh_token: session.refresh_token})
    .then(j => saveSession(toSession(j, session.user)))
    .catch(e => { if(e.status === 400 || e.status === 401){ saveSession(null); onAuthChange(); } throw e; })
    .finally(() => { refreshing = null; });
  await refreshing;
  return session?.access_token || null;
}

async function sb(path, {method = "GET", json, headers = {}} = {}){
  const tok = await accessToken();
  if(!tok){ const e = new Error("signin"); e.status = 401; throw e; }
  const r = await fetch(SB.url + path, {method,
    headers:{apikey:SB.key, Authorization:"Bearer " + tok, ...(json !== undefined ? {"content-type":"application/json"} : {}), ...headers},
    body: json !== undefined ? JSON.stringify(json) : undefined});
  const text = await r.text();
  if(!r.ok){ const e = new Error(text.slice(0, 200) || "sb"); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : null;
}

/* Readings made on this phone go up to the account; then the account's list becomes the local one. */
let syncing = null;
function syncPending(){
  if(!session) return Promise.resolve();
  return syncing ||= (async () => {
    for(const e of loadHist().filter(x => !x.synced).reverse()){
      try{
        await sb("/rest/v1/readings", {method:"POST", headers:{Prefer:"resolution=merge-duplicates,return=minimal"},
          json:{id:e.id, created_at:new Date(e.t).toISOString(), card:e.name, position:e.pos, question:e.q || null, body:e.body, thumb:e.thumb || null}});
        storeHist(loadHist().map(x => x.id === e.id ? {...x, synced:true} : x));
        if(current?.id === e.id) current.synced = true;
      }catch{ break; }
    }
  })().finally(() => { syncing = null; });
}
async function pullRemote(){
  if(!session) return;
  try{
    const rows = await sb("/rest/v1/readings?select=id,created_at,card,position,question,body,thumb&order=created_at.desc&limit=200");
    const remote = (rows || []).map(r => ({id:r.id, t:Date.parse(r.created_at), name:r.card, pos:r.position || "",
      q:r.question || "", body:Array.isArray(r.body) ? r.body : [], thumb:r.thumb || "", synced:true}));
    const ids = new Set(remote.map(r => r.id));
    storeHist([...loadHist().filter(e => !e.synced && !ids.has(e.id)), ...remote].sort((a, b) => b.t - a.t));
  }catch{ /* offline: keep what is on the phone */ }
}

async function onAuthChange(){
  if(session){ await syncPending(); await pullRemote(); }
  else storeHist(loadHist().filter(e => !e.synced));   // signed out: account readings leave this phone
  renderAccount();
  if(view === "history") openHistory();
}

/* sign-in flow: email → 6-digit code from the email */
let pendingEmail = "", resendTimer = null;
function authError(e){
  const c = String(e.code || "") + " " + String(e.message || "");
  if(e.status === 429 || /rate.?limit/i.test(c)) return "Забагато листів за короткий час. Спробуйте за кілька хвилин.";
  if(/not authorized/i.test(c)) return "Лист не надіслано: тестова пошта Supabase пише лише на адресу власника проєкту. Потрібно підключити свій SMTP.";
  if(/otp|token|expired|invalid.*(code|token)/i.test(c) || e.status === 403) return "Код не підійшов або вже застарів. Спробуйте ще раз.";
  if(/email/i.test(c)) return "Перевірте адресу email.";
  return navigator.onLine ? "Сталася помилка. Спробуйте ще раз." : "Схоже, немає інтернету.";
}
function accStatus(text, err){ $("accStatus").textContent = text || ""; $("accStatus").className = "status" + (err ? " err" : ""); }
function startResendCooldown(){
  let n = 60; clearInterval(resendTimer);
  const tick = () => { $("accResend").disabled = n > 0; $("accResend").textContent = n > 0 ? `Надіслати ще раз (${n})` : "Надіслати ще раз"; n--; if(n < -1) clearInterval(resendTimer); };
  tick(); resendTimer = setInterval(tick, 1000);
}
async function requestCode(email){
  accStatus(""); $("accSend").disabled = true;
  try{
    await sbAuth("otp", {email, create_user:true});
    pendingEmail = email;
    $("accStep1").hidden = true; $("accStep2").hidden = false;
    $("accSentTo").textContent = "Код надіслано на " + email + ". Якщо листа немає, перевірте спам.";
    $("accCode").value = ""; $("accCode").focus();
    startResendCooldown();
  }catch(e){ accStatus(authError(e), true); }
  finally{ $("accSend").disabled = false; }
}
$("accStep1").addEventListener("submit", e => { e.preventDefault(); const v = $("accEmail").value.trim().toLowerCase(); if(v) requestCode(v); });
$("accResend").addEventListener("click", () => { if(pendingEmail) requestCode(pendingEmail); });
$("accOther").addEventListener("click", () => { pendingEmail = ""; accStatus(""); renderAccount(); $("accEmail").focus(); });
$("accStep2").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("accCode").value.replace(/\D/g, "");
  if(code.length < 6) return;
  $("accVerify").disabled = true; accStatus("");
  try{
    saveSession(toSession(await sbAuth("verify", {type:"email", email:pendingEmail, token:code})));
    pendingEmail = "";
    await onAuthChange();
    checkAccess();
    if(pending){ const p = pending; pending = null; interpret(p.blob, p.q); }
    else show(returnView === "account" ? "camera" : returnView);
  }catch(err){ accStatus(authError(err), true); }
  finally{ $("accVerify").disabled = false; }
});
$("accCode").addEventListener("input", e => { const v = e.target.value.replace(/\D/g, ""); if(v !== e.target.value) e.target.value = v; });

$("accSignout").addEventListener("click", async () => {
  const tok = session?.access_token;
  saveSession(null); usage = null;
  if(tok) sbAuth("logout", {}, tok).catch(()=>{});
  await onAuthChange();
  accStatus("Ви вийшли з акаунта.");
});
let delArmed = false, delAccTimer = null;
$("accDelete").addEventListener("click", async () => {
  const b = $("accDelete");
  if(!delArmed){
    delArmed = true; b.textContent = "Точно видалити акаунт і всю історію?";
    delAccTimer = setTimeout(() => { delArmed = false; b.textContent = "Видалити акаунт"; }, 5000);
    return;
  }
  clearTimeout(delAccTimer); delArmed = false; b.disabled = true;
  try{
    const r = await fetch("/api/account", {method:"DELETE", headers: await apiHeaders()});
    if(!r.ok) throw new Error("delete");
    saveSession(null); usage = null; ls.del(KEY);
    await onAuthChange();
    accStatus("Акаунт і всю історію видалено.");
  }catch{ accStatus("Не вдалося видалити акаунт. Спробуйте ще раз.", true); }
  finally{ b.disabled = false; b.textContent = "Видалити акаунт"; }
});

function renderAccount(){
  $("accBtn").hidden = !accountsOn;
  $("accBtn").textContent = session ? "Акаунт" : "Увійти";
  $("accTitle").textContent = session ? "Акаунт" : "Вхід";
  $("accStep1").hidden = !accountsOn || !!session || !!pendingEmail;
  $("accStep2").hidden = !accountsOn || !!session || !pendingEmail;
  $("accIn").hidden = !session;
  if(session){
    $("accWho").textContent = session.user?.email || "";
    $("accUsage").textContent = usage ? `${usage.used} з ${usage.limit} тлумачень` : "—";
  }
}
function openAccount(lead){
  if(view !== "account") returnView = view;
  $("accLead").textContent = lead || (session ? "Історія тлумачень зберігається в акаунті й доступна на всіх ваших пристроях."
    : accountsOn ? "Вхід без пароля: введіть email, ми надішлемо код. Історія тлумачень збережеться в акаунті."
    : "Акаунти ще не підключені. Історія зберігається на цьому телефоні.");
  accStatus(""); renderAccount(); show("account"); $("account").scrollTop = 0;
}
$("accBtn").addEventListener("click", () => openAccount());
$("accountBack").addEventListener("click", () => { pending = null; show(returnView === "account" ? "camera" : returnView); });

/* ---------- install to the home screen ---------- */
let deferredPrompt = null, installMode = null;   // "prompt" (Android/desktop Chrome), "ios", "menu" (other Android browsers)
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = () => /android/i.test(navigator.userAgent);
const INSTALL_TEXT = {
  prompt:"Встановіть Таросвіт на головний екран: відкривається як застосунок.",
  ios:"Щоб встановити на iPhone: натисніть «Поділитися» в Safari, потім «На початковий екран».",
  menu:"Щоб встановити: відкрийте меню браузера і виберіть «Встановити застосунок» або «Додати на головний екран».",
};
function renderInstall(){
  if(!installMode || isStandalone() || ls.get("tarosvit.installDismissed")){ $("installBar").hidden = true; return; }
  $("installText").textContent = INSTALL_TEXT[installMode];
  $("installBtn").hidden = installMode !== "prompt";
  $("installBar").hidden = false;
}
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredPrompt = e; installMode = "prompt"; renderInstall(); });
$("installBtn").addEventListener("click", async () => {
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(()=>{});
  deferredPrompt = null; installMode = null; renderInstall();
});
$("installClose").addEventListener("click", () => { ls.set("tarosvit.installDismissed", "1"); renderInstall(); });
window.addEventListener("appinstalled", () => { installMode = null; renderInstall(); });
if(!isStandalone()){
  if(isIOS()){ installMode = "ios"; renderInstall(); }
  // Android browsers that never offer the install prompt: explain the menu route instead
  else if(isAndroid()) setTimeout(() => { if(!installMode){ installMode = "menu"; renderInstall(); } }, 4000);
}

/* ---------- start ---------- */
$("ver").textContent = VERSION;
const splash = $("splash");
splash.addEventListener("animationend", e => { if(e.animationName === "splashOut") splash.remove(); });
splash.addEventListener("click", () => splash.remove());

renderAccount();
show("camera");
checkAccess().then(() => { if(session) onAuthChange(); });
window.addEventListener("online", () => syncPending());
if("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(()=>{}));
