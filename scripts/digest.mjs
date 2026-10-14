import { execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { google } from 'googleapis';

const { SINCE, UNTIL, APP_URL, APP_LOGIN_STEPS, DRIVE_FOLDER_ID, GOOGLE_SA_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const day = (d) => new Date(run('date', ['-d', d, '+%F'])).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }); // GNU date (runner Linux)
const label = `${day(SINCE)} – ${day(UNTIL)}`;

// 1. Historique git
const log = run('git', ['log', `--since=${SINCE}`, `--until=${UNTIL}`, '--no-merges', '--stat=100', '--date=short',
  '--format=--- %h %ad%n%s%n%b']).slice(0, 60000);
if (!log.trim()) { console.log('Aucun commit sur la période.'); process.exit(0); }

// 2. Analyse Copilot -> JSON
const prompt = `Tu écris la newsletter hebdo d'une équipe produit pour des collègues NON techniques.
Voici les commits de la période (${label}). Tu peux aussi lire le repo pour comprendre l'app (routes, libellés).

${log}

Garde uniquement ce qui est visible ou utile pour un utilisateur (nouvelles features, corrections de bugs notables, améliorations).
Ignore refactos, CI, dépendances, tests. Regroupe les commits liés. Maximum 8 éléments.
Ton: informel, simple, en français, zéro jargon, pas de noms de fichiers ni de hashes. Dis ce que ça change concrètement.
Pour chaque élément, propose aussi des "steps" pour que Playwright le montre dans l'app (${APP_URL}).
Étapes possibles: {"goto":"/chemin"}, {"click":"sélecteur css"}, {"fill":["sélecteur","texte"]}, {"wait":ms}. Laisse "steps" vide si ce n'est pas montrable.

Réponds UNIQUEMENT avec ce JSON:
{"title":"...","intro":"2 phrases max","items":[{"kind":"feature|fix|improvement","title":"...","text":"2-3 phrases","steps":[]}]}`;
const out = run('copilot', ['-p', prompt, '-s', '--allow-all-tools']);
const digest = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
if (!digest.items?.length) { console.log('Rien de pertinent à présenter.'); process.exit(0); }

// 3. Médias (png + gif + mp4) par élément
const play = async (steps, page) => {
  for (const s of steps) {
    if (s.goto) await page.goto(new URL(s.goto, APP_URL).href);
    else if (s.click) await page.click(s.click, { timeout: 8000 });
    else if (s.fill) await page.fill(s.fill[0], s.fill[1], { timeout: 8000 });
    else if (s.wait) await page.waitForTimeout(s.wait);
  }
};
mkdirSync('media', { recursive: true });
const browser = await chromium.launch();
const login = await browser.newContext();
await play(JSON.parse(APP_LOGIN_STEPS || '[]'), await login.newPage());
const state = await login.storageState();

for (const [i, it] of digest.items.entries()) {
  if (!it.steps?.length) continue;
  const size = { width: 1280, height: 720 };
  const ctx = await browser.newContext({ storageState: state, viewport: size, recordVideo: { dir: `media/v${i}`, size } });
  const page = await ctx.newPage();
  try {
    await page.goto(APP_URL);
    await play(it.steps, page);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `media/${i}.png` });
    const video = await page.video().path();
    await ctx.close();
    run('ffmpeg', ['-y', '-i', video, '-vf', 'fps=10,scale=800:-1', `media/${i}.gif`]);
    run('ffmpeg', ['-y', '-i', video, `media/${i}.mp4`]);
    it.media = true;
  } catch (e) {
    console.warn(`Média ignoré pour "${it.title}": ${e.message}`); // l'élément reste dans le doc, sans visuel
    await ctx.close().catch(() => {});
  }
}
await browser.close();

// 4. Google Drive / Docs / Slides
const scopes = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/presentations'];
let auth;
if (GOOGLE_REFRESH_TOKEN) { // OAuth: les fichiers appartiennent à ton compte (Gmail perso OK)
  auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
} else { // compte de service: exige un Shared Drive (pas de quota de stockage)
  auth = new google.auth.GoogleAuth({ credentials: JSON.parse(GOOGLE_SA_KEY), scopes });
}
const drive = google.drive({ version: 'v3', auth });
const slides = google.slides({ version: 'v1', auth });
const shared = { supportsAllDrives: true };
const publicIds = [];

const upload = async (name, mimeType, body, extra = {}) => (await drive.files.create({
  requestBody: { name, parents: [DRIVE_FOLDER_ID], ...extra }, media: { mimeType, body },
  fields: 'id,webViewLink', ...shared,
})).data;

for (const [i, it] of digest.items.entries()) {
  if (!it.media) continue;
  const f = (ext, mime) => upload(`${i}-${it.title}.${ext}`, mime, createReadStream(`media/${i}.${ext}`));
  const [png, gif, mp4] = await Promise.all([f('png', 'image/png'), f('gif', 'image/gif'), f('mp4', 'video/mp4')]);
  // Docs/Slides doivent pouvoir télécharger l'image: lien public le temps de l'import, révoqué ensuite
  for (const x of [png, gif]) {
    await drive.permissions.create({ fileId: x.id, requestBody: { role: 'reader', type: 'anyone' }, ...shared });
    publicIds.push(x.id);
  }
  Object.assign(it, { png: png.id, gif: gif.id, video: mp4.webViewLink });
}
const pub = (id) => `https://drive.google.com/uc?id=${id}`;

// Doc (HTML converti en Google Doc par Drive)
const html = `<h1>${esc(digest.title)}</h1><p>${esc(digest.intro)}</p>` + digest.items.map((it) =>
  `<h2>${esc(it.title)}</h2><p>${esc(it.text)}</p>` +
  (it.media ? `<p><img src="${pub(it.png)}" width="560"></p><p><a href="${it.video}">▶ Voir la démo en vidéo</a></p>` : '')).join('');
const doc = await upload(`Quoi de neuf — ${label}`, 'text/html', html, { mimeType: 'application/vnd.google-apps.document' });

// Slides: import de assets/template.pptx. Slide 1 = couverture ({{title}}, {{intro}}, {{period}}), slide 2 = modèle d'élément
// ({{item_title}}, {{item_text}} + une forme contenant {{media}}). Dupliquée pour chaque élément.
// Le .pptx versionné est converti en Google Slides à l'upload: le résultat est directement le deck du jour.
const deck = await upload(`Quoi de neuf — ${label}`, 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  createReadStream(`${import.meta.dirname}/../assets/template.pptx`), { mimeType: 'application/vnd.google-apps.presentation' });
const pres = (await slides.presentations.get({ presentationId: deck.id })).data;
const ids = [pres.slides[1].objectId];
const requests = [];
for (let k = 1; k < digest.items.length; k++) {
  ids.push(`item_${k}`);
  requests.push({ duplicateObject: { objectId: ids[k - 1], objectIds: { [ids[k - 1]]: ids[k] } } });
}
const text = (page, key, value) => ({ replaceAllText: {
  containsText: { text: `{{${key}}}`, matchCase: true }, replaceText: String(value), pageObjectIds: [page] } });
const titleId = pres.slides[0].objectId;
requests.push(text(titleId, 'title', digest.title), text(titleId, 'intro', digest.intro), text(titleId, 'period', label));
digest.items.forEach((it, k) => {
  const p = ids[k];
  requests.push(text(p, 'kind', { feature: 'Nouveauté', fix: 'Correction', improvement: 'Amélioration' }[it.kind] ?? 'Mise à jour'),
    text(p, 'item_title', it.title), text(p, 'item_text', it.text));
  requests.push(it.media
    ? { replaceAllShapesWithImage: { imageUrl: pub(it.gif), imageReplaceMethod: 'CENTER_INSIDE',
        containsText: { text: '{{media}}', matchCase: true }, pageObjectIds: [p] } }
    : text(p, 'media', ''));
});
await slides.presentations.batchUpdate({ presentationId: deck.id, requestBody: { requests } });

// Révocation des liens publics
for (const id of publicIds) await drive.permissions.delete({ fileId: id, permissionId: 'anyoneWithLink', ...shared });

const summary = `### Digest ${label}\n- [Doc](${doc.webViewLink})\n- [Slides](${deck.webViewLink})\n`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
