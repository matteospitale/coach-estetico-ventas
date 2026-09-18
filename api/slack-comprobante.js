// Vercel serverless function — sube los comprobantes de una venta nueva al canal de comprobantes de Slack,
// con todos los datos de la venta (ID de Kommo incluido) como comentario del archivo.
// Los webhooks de Slack no aceptan archivos, así que esto usa el token del bot de la app "Hub Coach".
// Variables de entorno en Vercel (Project → Settings → Environment Variables):
//   SLACK_BOT_TOKEN          → token del bot (empieza con xoxb-), con permisos files:write y chat:write
//   SLACK_CANAL_COMPROBANTES → opcional: ID de otro canal. Por defecto usa 🔒#comprobantes (C0C2SB6UH8B).
// El bot tiene que estar agregado al canal. Si falta el token, responde ok sin hacer nada,
// así el Hub nunca se rompe por Slack.

const TOKEN = process.env.SLACK_BOT_TOKEN || '';
const CANAL = process.env.SLACK_CANAL_COMPROBANTES || 'C0C2SB6UH8B';

function esc(s, max) {
  return String(s == null ? '' : s).slice(0, max || 200)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function usd(n) {
  var x = parseFloat(n);
  return isNaN(x) ? '—' : 'USD ' + x.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function texto(v, tipo) {
  var alumno = esc([v.nombre, v.apellido].filter(Boolean).join(' ') || 'Sin nombre');
  var lead = String(v.lead || '').replace(/[^0-9A-Za-z-]/g, '');
  var lineas = [
    (tipo === 'cuota' ? '🧾 *Comprobante de cuota*' : '🧾 *Comprobante de venta*') + ' · *' + alumno + '*',
    '*ID Kommo:* ' + (lead ? '<https://coachestetico.kommo.com/leads/detail/' + lead + '|' + lead + '>' : '—'),
    '*Curso:* ' + esc(v.curso) + (v.cursoCombo ? ' + ' + esc(v.cursoCombo) : ''),
    '*Monto:* ' + usd(v.monto) + (v.montoLocal ? ' (local: ' + esc(v.montoLocal, 30) + ')' : '') + ' · *Pago:* ' + esc(v.pago || '—', 60),
    '*Código comprobante:* ' + esc(v.codigo || '—', 80),
    '*País:* ' + esc(v.pais || '—', 40) + ' · *Canal:* ' + esc(v.canal || '—', 30),
    '*Email:* ' + esc(v.email || '—', 120) + ' · *Tel:* ' + esc(v.telefono || '—', 40),
    '*Asesor:* ' + esc(v.asesor || '—', 40) + ' · *Fecha:* ' + esc(v.fecha || '—', 20)
  ];
  if (v.cuotasPendientes) lineas.push('*Pagos pendientes:* ' + v.cuotasPendientes);
  if (v.nota) lineas.push('*Nota:* ' + esc(v.nota, 500));
  return lineas.join('\n');
}

async function slack(method, params, json) {
  var r = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: json
      ? { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json; charset=utf-8' }
      : { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString()
  });
  var d = await r.json();
  if (!d.ok) throw new Error(method + ': ' + d.error);
  return d;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!TOKEN) return res.status(200).json({ ok: true, skipped: 'Falta SLACK_BOT_TOKEN' });

  var b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  var v = b.venta || {};
  var archivos = (Array.isArray(b.archivos) ? b.archivos : []).slice(0, 2);
  if (!archivos.length) return res.status(400).json({ error: 'sin archivos' });

  try {
    var subidos = [];
    for (var i = 0; i < archivos.length; i++) {
      var m = /^data:([^;]+);base64,(.+)$/.exec(archivos[i] || '');
      if (!m) continue;
      var buf = Buffer.from(m[2], 'base64');
      var ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      var nombre = 'comprobante-' + (String(v.lead || 'sin-lead').replace(/[^0-9A-Za-z-]/g, '')) + (archivos.length > 1 ? '-' + (i + 1) : '') + '.' + ext;
      var up = await slack('files.getUploadURLExternal', { filename: nombre, length: String(buf.length) });
      var put = await fetch(up.upload_url, { method: 'POST', body: buf });
      if (!put.ok) throw new Error('upload ' + put.status);
      subidos.push({ id: up.file_id, title: nombre });
    }
    if (!subidos.length) return res.status(400).json({ error: 'archivos invalidos' });
    await slack('files.completeUploadExternal', {
      files: subidos,
      channel_id: CANAL,
      initial_comment: texto(v, b.tipo)
    }, true);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
