// Vercel serverless function — avisa en Slack cuando se carga una venta en el Hub.
// El link del webhook NO va en el código: se configura en Vercel como variable de entorno
// SLACK_WEBHOOK_VENTAS (Project → Settings → Environment Variables).
// Si la variable no está, responde ok sin hacer nada, así el Hub nunca se rompe por Slack.

const WEBHOOK = process.env.SLACK_WEBHOOK_VENTAS || '';

// Slack interpreta & < > como formato: se escapan para que un nombre raro no rompa el mensaje
function esc(s, max) {
  return String(s == null ? '' : s).slice(0, max || 120)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function usd(n) {
  var x = parseFloat(n);
  return isNaN(x) ? '—' : 'USD ' + x.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function cursoTxt(v) {
  return esc(v.curso, 160) + (v.cursoCombo ? ' + ' + esc(v.cursoCombo, 160) : '');
}

function mensajeVenta(v, tipo) {
  var titulo = tipo === 'cuota' ? '💳 *Cuota cobrada*' : '🟢 *Nueva venta*';
  var alumno = esc([v.nombre, v.apellido].filter(Boolean).join(' ') || 'Sin nombre');
  var lineas = [
    titulo + ' · *' + cursoTxt(v) + '*',
    alumno + (v.pais ? ' (' + esc(v.pais, 40) + ')' : '') + ' · *' + usd(v.monto) + '*' + (v.pago ? ' · ' + esc(v.pago, 60) : ''),
    'Asesor: ' + esc(v.asesor || '—', 40) +
      (v.comprobante ? ' · 📎 Comprobante cargado' : ' · ⚠️ Sin comprobante') +
      (v.enPartes && v.cuotasPendientes ? ' · 💰 ' + v.cuotasPendientes + ' pago' + (v.cuotasPendientes > 1 ? 's' : '') + ' pendiente' + (v.cuotasPendientes > 1 ? 's' : '') : '')
  ];
  return lineas.join('\n');
}

function mensajeImport(b) {
  var ventas = Array.isArray(b.ventas) ? b.ventas : [];
  var total = ventas.reduce(function (a, v) { return a + (parseFloat(v.monto) || 0); }, 0);
  var lineas = ['📥 *' + esc(b.asesor || 'Alguien', 40) + ' importó ' + ventas.length + ' venta' + (ventas.length !== 1 ? 's' : '') + ' desde Excel* · ' + usd(total)];
  ventas.slice(0, 15).forEach(function (v) {
    lineas.push('• ' + esc([v.nombre, v.apellido].filter(Boolean).join(' ') || 'Sin nombre') + ' — ' + cursoTxt(v) + ' — ' + usd(v.monto));
  });
  if (ventas.length > 15) lineas.push('…y ' + (ventas.length - 15) + ' más (ver en el Hub)');
  return lineas.join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!WEBHOOK) return res.status(200).json({ ok: true, skipped: 'SLACK_WEBHOOK_VENTAS no configurado' });

  var b = req.body || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  var text;
  if (b.tipo === 'import') text = mensajeImport(b);
  else if (b.tipo === 'venta' || b.tipo === 'cuota') text = mensajeVenta(b.venta || {}, b.tipo);
  else return res.status(400).json({ error: 'tipo invalido' });

  try {
    var r = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
