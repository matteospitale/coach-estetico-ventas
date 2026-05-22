module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: 'Kommo token no configurado en Vercel' });

  const { q, debug_raw } = req.query;
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });

  const BASE = 'https://coachestetico.kommo.com/api/v4';
  const hdrs = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };

  async function kfetch(path) {
    var r = await fetch(BASE + path, { headers: hdrs });
    var t = await r.text();
    if (!t || !t.trim()) return { _status: r.status, _empty: true };
    try { var j = JSON.parse(t); j._status = r.status; return j; }
    catch(e) { return { _status: r.status, _raw: t.substring(0, 500) }; }
  }

  function formatFecha(ts) {
    if (!ts) return '';
    var d = new Date(ts * 1000);
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
           ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }

  try {
    // ── Buscar lead con contactos ──
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

    // ── Recolectar todos los talks por contacto ──
    var allTalks = [];
    var talkDebug = [];

    for (var ci = 0; ci < contactIds.length; ci++) {
      var tResp = await kfetch('/talks?filter[contact_id][]=' + contactIds[ci] + '&limit=50');
      var tList = (tResp && tResp._embedded && tResp._embedded.talks) || [];
      talkDebug.push({ contactId: contactIds[ci], status: tResp._status, count: tList.length });
      allTalks = allTalks.concat(tList);
    }

    // Deduplicar por cualquier campo ID posible
    var seenIds = new Set();
    var uniqueTalks = [];
    allTalks.forEach(function(t) {
      // Kommo puede usar id, uuid, talk_id, o uid
      var tid = t.id || t.uuid || t.talk_id || t.uid || JSON.stringify(t).substring(0, 50);
      if (!seenIds.has(tid)) { seenIds.add(tid); uniqueTalks.push(t); }
    });

    // ── DEBUG RAW: estructura de los primeros 3 talks ──
    var rawTalkSample = uniqueTalks.slice(0, 3).map(function(t) {
      return { keys: Object.keys(t), id: t.id, uuid: t.uuid, talk_id: t.talk_id, uid: t.uid,
               _embedded_keys: t._embedded ? Object.keys(t._embedded) : [], source: t.source || t._embedded && t._embedded.source };
    });

    // ── Buscar mensajes: probar varios endpoints por cada talk ──
    var msgDebug = [];
    var items = [];

    for (var ti = 0; ti < Math.min(uniqueTalks.length, 15); ti++) {
      var talk = uniqueTalks[ti];
      var tId = talk.id || talk.uuid || talk.talk_id || talk.uid;
      var dbg = { talkId: tId, keys: Object.keys(talk), attempts: [] };

      // Intento 1: /messages?filter[talk_id][]=
      var m1 = await kfetch('/messages?filter[talk_id][]=' + tId + '&limit=250');
      var msgs1 = (m1 && m1._embedded && m1._embedded.messages) || [];
      dbg.attempts.push({ url: '/messages?filter[talk_id][]=' + tId, status: m1._status, msgCount: msgs1.length,
                          embeddedKeys: m1._embedded ? Object.keys(m1._embedded) : [], sample: msgs1.slice(0,1) });

      if (msgs1.length === 0) {
        // Intento 2: /talks/{id}/messages
        var m2 = await kfetch('/talks/' + tId + '/messages?limit=250');
        var msgs2 = (m2 && m2._embedded && m2._embedded.messages) || [];
        dbg.attempts.push({ url: '/talks/' + tId + '/messages', status: m2._status, msgCount: msgs2.length,
                            embeddedKeys: m2._embedded ? Object.keys(m2._embedded) : [], sample: msgs2.slice(0,1) });

        if (msgs2.length === 0) {
          // Intento 3: ver si el talk tiene embedded messages ya
          var embMsgs = talk._embedded && (talk._embedded.messages || talk._embedded.chats || talk._embedded.items);
          dbg.attempts.push({ url: 'embedded_in_talk', msgs: embMsgs ? embMsgs.slice(0,2) : null });
        }

        if (msgs2.length > 0) {
          dbg.source = 'intento2';
          msgs2.forEach(function(m) { items.push(buildItem(m, talk, tId)); });
        }
      } else {
        dbg.source = 'intento1';
        msgs1.forEach(function(m) { items.push(buildItem(m, talk, tId)); });
      }

      msgDebug.push(dbg);
    }

    function buildItem(m, talk, tId) {
      var texto = '';
      if (m.content) texto = m.content.text || m.content.body || '';
      if (!texto && m.text) texto = m.text;
      if (!texto && m.content && m.content.type) texto = '[' + m.content.type + ']';
      var authorType = (m.author && m.author.type) || (m.created_by ? 'user' : 'contact');
      return {
        ts: m.created_at || m.timestamp || 0,
        fecha: formatFecha(m.created_at || m.timestamp),
        tipo: authorType === 'contact' ? 'entrante' : 'saliente',
        texto: String(texto).substring(0, 1000),
        canal: { id: 'chat', label: 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' },
        fuente: 'chat'
      };
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

    return res.status(200).json({
      debug: {
        contactIds: contactIds,
        talkDebug: talkDebug,
        uniqueTalksCount: uniqueTalks.length,
        rawTalkSample: rawTalkSample,
        msgDebug: msgDebug
      },
      total: items.length,
      notas: items
    });

  } catch(e) {
    return res.status(500).json({ error: 'Error Kommo: ' + e.message, stack: e.stack });
  }
};
