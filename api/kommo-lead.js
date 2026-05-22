module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: 'Kommo token no configurado en Vercel' });

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });

  const BASE = 'https://coachestetico.kommo.com/api/v4';
  const hdrs = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

  async function kfetch(path) {
    var r = await fetch(BASE + path, { headers: hdrs });
    var t = await r.text();
    if (!t || !t.trim()) return { _status: r.status, _empty: true };
    try { var j = JSON.parse(t); j._status = r.status; return j; }
    catch(e) { return { _status: r.status, _raw: t.substring(0, 300) }; }
  }

  function formatFecha(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
           ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }

  // Extraer texto del campo value_after de un evento de mensaje
  function extractText(ev) {
    if (!ev.value_after || !ev.value_after.length) return '';
    var va = ev.value_after[0];
    // Prueba todos los formatos posibles de Kommo
    return (va.message && (va.message.text || va.message.body || va.message.content)) ||
           va.text || va.body || va.content ||
           (va.attachment && va.attachment.name ? '[Archivo: ' + va.attachment.name + ']' : '') ||
           '';
  }

  // Canal a partir del origin del talk
  function canalFromOrigin(origin) {
    if (!origin) return { id: 'chat', label: 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' };
    if (origin.includes('wa') || origin.includes('whatsapp'))
      return { id: 'whatsapp', label: 'WhatsApp', color: '#25D366', bg: 'rgba(37,211,102,0.10)' };
    if (origin.includes('instagram'))
      return { id: 'instagram', label: 'Instagram', color: '#E1306C', bg: 'rgba(225,48,108,0.09)' };
    if (origin.includes('facebook') || origin.includes('fb'))
      return { id: 'facebook', label: 'Facebook', color: '#1877F2', bg: 'rgba(24,119,242,0.09)' };
    return { id: 'chat', label: 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' };
  }

  try {
    // ── Buscar lead ──
    var lead = null;
    if (/^\d+$/.test(q.trim())) {
      var d = await kfetch('/leads/' + q.trim() + '?with=contacts');
      if (d && d.id) lead = d;
    } else {
      var d2 = await kfetch('/leads?query=' + encodeURIComponent(q.trim()) + '&limit=1&with=contacts');
      var arr = d2 && d2._embedded && d2._embedded.leads;
      if (arr && arr.length) lead = arr[0];
    }
    if (!lead) return res.status(404).json({ error: 'Lead "' + q + '" no encontrado' });

    var contacts = (lead._embedded && lead._embedded.contacts) || [];
    var contactIds = contacts.map(function(c) { return c.id; }).filter(Boolean);

    // ── Mapa de talk_id → canal (origin) ──
    var talkCanal = {};
    for (var ci0 = 0; ci0 < contactIds.length; ci0++) {
      var tResp = await kfetch('/talks?filter[contact_id][]=' + contactIds[ci0] + '&limit=50');
      var tList = (tResp && tResp._embedded && tResp._embedded.talks) || [];
      tList.forEach(function(t) {
        if (t.talk_id) talkCanal[t.talk_id] = canalFromOrigin(t.origin);
      });
    }

    var items = [];
    var seenEventIds = new Set();
    var debug = { leadId: lead.id, contactIds: contactIds, talkCanalMap: talkCanal, rawMsgSample: [] };

    var MSG_TYPES = '&filter[type][]=incoming_chat_message&filter[type][]=outgoing_chat_message&filter[type][]=entity_direct_message';

    // ── Eventos de mensajes del LEAD ──
    var evLead = await kfetch('/events?filter[lead_id]=' + lead.id + MSG_TYPES + '&limit=250');
    var leadEvs = (evLead && evLead._embedded && evLead._embedded.events) || [];
    debug.leadMsgCount = leadEvs.length;

    // Guardar muestra cruda para debug
    debug.rawMsgSample = leadEvs.slice(0, 3).map(function(ev) {
      return { type: ev.type, created_at: ev.created_at, value_after: ev.value_after, value_before: ev.value_before };
    });

    leadEvs.forEach(function(ev) {
      if (seenEventIds.has(ev.id)) return;
      seenEventIds.add(ev.id);
      var texto = extractText(ev);
      if (!texto || !texto.trim()) return;
      var canal = (ev.value_after && ev.value_after[0] && ev.value_after[0].talk_id && talkCanal[ev.value_after[0].talk_id]) ||
                  canalFromOrigin('');
      items.push({
        ts: ev.created_at || 0, fecha: formatFecha(ev.created_at),
        tipo: ev.type === 'incoming_chat_message' ? 'entrante' : 'saliente',
        texto: String(texto).substring(0, 1000),
        canal: canal,
        fuente: 'evento'
      });
    });

    // ── Eventos de mensajes por CONTACTO (captura mensajes no ligados al lead) ──
    for (var ci = 0; ci < contactIds.length; ci++) {
      var evCon = await kfetch('/events?filter[contact_id]=' + contactIds[ci] + MSG_TYPES + '&limit=250');
      var conEvs = (evCon && evCon._embedded && evCon._embedded.events) || [];
      conEvs.forEach(function(ev) {
        if (seenEventIds.has(ev.id)) return;
        seenEventIds.add(ev.id);
        var texto = extractText(ev);
        if (!texto || !texto.trim()) return;
        var canal = (ev.value_after && ev.value_after[0] && ev.value_after[0].talk_id && talkCanal[ev.value_after[0].talk_id]) ||
                    canalFromOrigin('');
        items.push({
          ts: ev.created_at || 0, fecha: formatFecha(ev.created_at),
          tipo: ev.type === 'incoming_chat_message' ? 'entrante' : 'saliente',
          texto: String(texto).substring(0, 1000),
          canal: canal,
          fuente: 'evento'
        });
      });
    }

    // ── Notas manuales ──
    var notesData = await kfetch('/leads/' + lead.id + '/notes?limit=250&order[id]=asc');
    var notesList = (notesData && notesData._embedded && notesData._embedded.notes) || [];
    notesList.forEach(function(n) {
      var texto = '';
      if (n.params) texto = n.params.text || n.params.service || n.params.body || '';
      if (!texto && n.text) texto = n.text;
      if (!texto || texto.trim().length < 2) return;
      var icono = n.note_type === 25 ? '📞 Llamada ent. · ' : n.note_type === 26 ? '📞 Llamada sal. · ' : '';
      items.push({
        ts: n.created_at || 0, fecha: formatFecha(n.created_at),
        tipo: (n.created_by || 0) === 0 ? 'entrante' : 'saliente',
        texto: icono + String(texto).substring(0, 1000),
        canal: { id: 'nota', label: 'Nota', color: '#9a8f87', bg: 'rgba(154,143,135,0.10)' },
        fuente: 'nota'
      });
    });

    items.sort(function(a, b) { return a.ts - b.ts; });

    return res.status(200).json({ debug: debug, total: items.length, notas: items });

  } catch(e) {
    return res.status(500).json({ error: 'Error: ' + e.message, stack: e.stack });
  }
};
