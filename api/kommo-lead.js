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

    var items = [];
    var debug = { contactIds: contactIds, approaches: [] };

    // ── APPROACH 1: Events API (lead) ──
    var evLead = await kfetch('/events?filter[entity][id][]=' + lead.id + '&filter[entity][type][]=lead&limit=250');
    var leadEvents = (evLead && evLead._embedded && evLead._embedded.events) || [];
    var leadEventTypes = leadEvents.reduce(function(acc, e) {
      acc[e.type] = (acc[e.type] || 0) + 1; return acc;
    }, {});
    debug.approaches.push({
      name: 'events_lead',
      status: evLead._status,
      total: leadEvents.length,
      types: leadEventTypes,
      sample: leadEvents.slice(0, 2)
    });

    // Extract chat messages from lead events
    leadEvents.forEach(function(ev) {
      var tipo = ev.type || '';
      if (!tipo.includes('chat') && !tipo.includes('message') && !tipo.includes('msg')) return;
      var texto = '';
      if (ev.value_after && ev.value_after[0]) {
        var va = ev.value_after[0];
        texto = (va.message && (va.message.text || va.message.body)) ||
                (va.text) || JSON.stringify(va).substring(0, 300);
      }
      items.push({
        ts: ev.created_at || 0, fecha: formatFecha(ev.created_at),
        tipo: tipo.includes('incoming') ? 'entrante' : 'saliente',
        texto: String(texto).substring(0, 1000),
        canal: { id: 'chat', label: 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' },
        fuente: 'evento'
      });
    });

    // ── APPROACH 2: Events API (contacts) ──
    for (var ci = 0; ci < Math.min(contactIds.length, 3); ci++) {
      var evCon = await kfetch('/events?filter[entity][id][]=' + contactIds[ci] + '&filter[entity][type][]=contact&limit=100');
      var conEvents = (evCon && evCon._embedded && evCon._embedded.events) || [];
      var conTypes = conEvents.reduce(function(acc, e) {
        acc[e.type] = (acc[e.type] || 0) + 1; return acc;
      }, {});
      debug.approaches.push({
        name: 'events_contact_' + contactIds[ci],
        status: evCon._status,
        total: conEvents.length,
        types: conTypes,
        sample: conEvents.slice(0, 2)
      });

      conEvents.forEach(function(ev) {
        var tipo = ev.type || '';
        if (!tipo.includes('chat') && !tipo.includes('message') && !tipo.includes('msg')) return;
        var texto = '';
        if (ev.value_after && ev.value_after[0]) {
          var va = ev.value_after[0];
          texto = (va.message && (va.message.text || va.message.body)) ||
                  (va.text) || JSON.stringify(va).substring(0, 300);
        }
        items.push({
          ts: ev.created_at || 0, fecha: formatFecha(ev.created_at),
          tipo: tipo.includes('incoming') ? 'entrante' : 'saliente',
          texto: String(texto).substring(0, 1000),
          canal: { id: 'chat', label: 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' },
          fuente: 'evento'
        });
      });
    }

    // ── APPROACH 3: /chats endpoint ──
    for (var ci2 = 0; ci2 < Math.min(contactIds.length, 2); ci2++) {
      var chatResp = await kfetch('/chats?filter[contact_id][]=' + contactIds[ci2] + '&limit=20');
      var embKeys = chatResp && chatResp._embedded ? Object.keys(chatResp._embedded) : [];
      debug.approaches.push({
        name: 'chats_contact_' + contactIds[ci2],
        status: chatResp._status,
        embeddedKeys: embKeys,
        sample: chatResp._embedded ? JSON.stringify(chatResp._embedded).substring(0, 300) : null
      });
    }

    // ── APPROACH 4: Talks with ?with=messages ──
    var talkSample = await kfetch('/talks?filter[contact_id][]=' + contactIds[0] + '&limit=1&with=messages');
    var talkSampleList = (talkSample && talkSample._embedded && talkSample._embedded.talks) || [];
    debug.approaches.push({
      name: 'talks_with_messages',
      status: talkSample._status,
      count: talkSampleList.length,
      sample: talkSampleList.slice(0, 1).map(function(t) {
        return { keys: Object.keys(t), embedded_keys: t._embedded ? Object.keys(t._embedded) : [], talk_id: t.talk_id };
      })
    });

    // If messages embedded in talk response
    talkSampleList.forEach(function(talk) {
      var msgs = talk._embedded && (talk._embedded.messages || talk._embedded.chats);
      if (!msgs) return;
      msgs.forEach(function(m) {
        var texto = (m.content && (m.content.text || m.content.body)) || m.text || '';
        items.push({
          ts: m.created_at || m.timestamp || 0, fecha: formatFecha(m.created_at || m.timestamp),
          tipo: (m.author && m.author.type === 'contact') ? 'entrante' : 'saliente',
          texto: String(texto).substring(0, 1000),
          canal: { id: 'chat', label: 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' },
          fuente: 'talk_embedded'
        });
      });
    });

    // ── APPROACH 5: /chats/{chat_id}/messages via talk's chat_id ──
    if (talkSampleList.length && talkSampleList[0].chat_id) {
      var chatId = talkSampleList[0].chat_id;
      var chatMsgs = await kfetch('/chats/' + chatId + '/messages?limit=50');
      var chatMsgList = (chatMsgs && chatMsgs._embedded && chatMsgs._embedded.messages) || [];
      debug.approaches.push({
        name: 'chat_id_messages_' + chatId,
        status: chatMsgs._status,
        count: chatMsgList.length,
        embeddedKeys: chatMsgs._embedded ? Object.keys(chatMsgs._embedded) : [],
        sample: chatMsgList.slice(0, 1)
      });
    }

    // ── Notas (siempre funciona) ──
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
