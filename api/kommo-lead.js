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

  function detectarCanal(talk) {
    var src = (talk._embedded && talk._embedded.source) || {};
    var tipo = (src.type || src.code || talk.source_code || talk.channel_type || talk.type || '').toLowerCase();
    var nombre = src.name || src.origin || talk.source_name || talk.name || '';
    var nb = nombre.toLowerCase();

    if (tipo.includes('instagram') || nb.includes('instagram'))
      return { id: 'instagram', label: 'Instagram', color: '#C13584', bg: 'rgba(193,53,132,0.10)' };
    if (tipo.includes('facebook') || nb.includes('facebook') || nb.includes('fb messenger'))
      return { id: 'facebook', label: 'Facebook', color: '#1877F2', bg: 'rgba(24,119,242,0.10)' };
    if (tipo.includes('telegram') || nb.includes('telegram'))
      return { id: 'telegram', label: 'Telegram', color: '#229ED9', bg: 'rgba(34,158,217,0.10)' };
    if (tipo.includes('whatsapp') || tipo.includes('waba') || nb.includes('whatsapp') || nb.includes('wapp')) {
      var num = nombre.replace(/[^0-9+]/g, '').trim();
      return { id: 'whatsapp', label: 'WhatsApp' + (num ? ' ' + num : ''), color: '#25D366', bg: 'rgba(37,211,102,0.10)' };
    }
    return { id: 'chat', label: nombre || 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' };
  }

  function textoMsg(content) {
    if (!content) return '';
    var t = content.text || content.body || '';
    if (t) return t;
    var map = { image: '🖼 Imagen', video: '🎥 Video', voice: '🎤 Audio', file: '📎 Archivo', sticker: '🖼 Sticker' };
    return map[content.type] || (content.type ? '[' + content.type + ']' : '');
  }

  try {
    // ── 1. Buscar lead ──
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

    var debug = { leadId: lead.id, contactIds: [], talksFound: 0, talksErrors: [], msgsFound: 0 };
    var items = [];

    // ── 2. Contactos del lead ──
    var contactIds = [];
    var embedded = lead._embedded || {};
    var contacts = embedded.contacts || [];
    contacts.forEach(function(c) { if (c.id) contactIds.push(c.id); });
    debug.contactIds = contactIds;

    // ── 3. Talks: buscar por contacto Y por lead (ambos métodos) ──
    var talks = [];

    // Método A: por lead entity
    try {
      var tA = await kfetch('/talks?filter[entity_id][]=' + lead.id + '&filter[entity_type][]=leads&limit=50');
      var tAlks = (tA && tA._embedded && tA._embedded.talks) || [];
      talks = talks.concat(tAlks);
      debug.talksErrors.push({ metodoA: tA._status || 'ok', count: tAlks.length });
    } catch(e) { debug.talksErrors.push({ metodoA: 'error', msg: e.message }); }

    // Método B: por contacto
    for (var ci = 0; ci < contactIds.length; ci++) {
      try {
        var tB = await kfetch('/talks?filter[contact_id][]=' + contactIds[ci] + '&limit=50');
        var tBlks = (tB && tB._embedded && tB._embedded.talks) || [];
        debug.talksErrors.push({ metodoB_contact: contactIds[ci], status: tB._status, count: tBlks.length });
        // Agregar solo talks no duplicados
        tBlks.forEach(function(tb) {
          if (!talks.find(function(t) { return t.id === tb.id; })) talks.push(tb);
        });
      } catch(e) { debug.talksErrors.push({ metodoB: 'error', contactId: contactIds[ci], msg: e.message }); }
    }

    debug.talksFound = talks.length;

    // ── 4. Mensajes de cada talk ──
    var talkPromises = talks.slice(0, 15).map(async function(talk) {
      var canal = detectarCanal(talk);
      var msgsData = await kfetch('/messages?filter[talk_id][]=' + talk.id + '&limit=250');
      var msgs = (msgsData && msgsData._embedded && msgsData._embedded.messages) || [];
      debug.msgsFound += msgs.length;
      return msgs.map(function(m) {
        var texto = textoMsg(m.content);
        if (!texto) return null;
        var authorType = (m.author && m.author.type) || 'user';
        return {
          ts:    m.created_at || 0,
          fecha: formatFecha(m.created_at),
          tipo:  authorType === 'contact' ? 'entrante' : 'saliente',
          texto: String(texto).substring(0, 1000),
          canal: canal,
          fuente:'chat'
        };
      }).filter(Boolean);
    });

    var talkResults = await Promise.all(talkPromises);
    talkResults.forEach(function(msgs) { items = items.concat(msgs); });

    // ── 5. Notas manuales ──
    try {
      var notesData = await kfetch('/leads/' + lead.id + '/notes?limit=250&order[id]=asc');
      var notesList = (notesData && notesData._embedded && notesData._embedded.notes) || [];
      notesList.forEach(function(n) {
        var texto = '';
        if (n.params) texto = n.params.text || n.params.service || n.params.body || n.params.message || '';
        if (!texto && n.text) texto = n.text;
        if (!texto || texto.trim().length < 2) return;
        var icono = n.note_type === 25 ? '📞 Llamada ent. · ' : n.note_type === 26 ? '📞 Llamada sal. · ' : n.note_type === 12 ? '📎 · ' : '';
        items.push({
          ts:    n.created_at || 0,
          fecha: formatFecha(n.created_at),
          tipo:  (n.created_by || 0) === 0 ? 'entrante' : 'saliente',
          texto: icono + String(texto).substring(0, 1000),
          canal: { id: 'nota', label: 'Nota', color: '#9a8f87', bg: 'rgba(154,143,135,0.10)' },
          fuente:'nota'
        });
      });
    } catch(e) {}

    // ── 6. Ordenar todo cronológicamente ──
    items.sort(function(a, b) { return a.ts - b.ts; });

    var cf = lead.custom_fields_values || [];
    function getField(name) {
      var f = cf.find(function(x) { return (x.field_name || '').toLowerCase() === name.toLowerCase(); });
      return f ? (f.values && f.values[0] && f.values[0].value || '') : '';
    }

    return res.status(200).json({
      lead: {
        id: lead.id, nombre: lead.name || 'Sin nombre',
        etapa: String(lead.status_id || '—'),
        interes: getField('Interes') || getField('Interés') || '',
        tags: (lead.tags || []).map(function(t) { return t.name; }).join(', '),
        dias_sin_actividad: lead.updated_at ? Math.floor((Math.floor(Date.now()/1000) - lead.updated_at) / 86400) : 0,
        presupuesto: lead.price || 0
      },
      debug: debug,   // ← temporal para diagnóstico
      total: items.length,
      notas: items
    });

  } catch(e) {
    return res.status(500).json({ error: 'Error Kommo: ' + e.message });
  }
};
