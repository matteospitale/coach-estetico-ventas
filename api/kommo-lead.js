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
    var debug = { contactIds: contactIds, probes: [] };

    // ── PROBE 1: Events sin filtro de entidad (¿funciona el endpoint?) ──
    var evNoFilter = await kfetch('/events?limit=10');
    var evNoFilterList = (evNoFilter && evNoFilter._embedded && evNoFilter._embedded.events) || [];
    debug.probes.push({
      name: 'events_no_filter',
      status: evNoFilter._status,
      count: evNoFilterList.length,
      types: evNoFilterList.map(function(e) { return e.type; }),
      raw: evNoFilter._raw || null
    });

    // ── PROBE 2: Events filtrado por lead_id (sintaxis alternativa) ──
    var evAlt = await kfetch('/events?filter[lead_id]=' + lead.id + '&limit=100');
    var evAltList = (evAlt && evAlt._embedded && evAlt._embedded.events) || [];
    var evAltTypes = evAltList.reduce(function(acc, e) { acc[e.type] = (acc[e.type]||0)+1; return acc; }, {});
    debug.probes.push({
      name: 'events_by_lead_id',
      status: evAlt._status,
      count: evAltList.length,
      types: evAltTypes,
      raw: evAlt._raw || null
    });

    // Extract chat messages from events (if any)
    evAltList.forEach(function(ev) {
      var tipo = (ev.type || '');
      if (!tipo.includes('chat') && !tipo.includes('message')) return;
      var va = ev.value_after && ev.value_after[0];
      var texto = (va && va.message && (va.message.text || va.message.body)) || (va && va.text) || JSON.stringify(va||{}).substring(0,200);
      items.push({
        ts: ev.created_at || 0, fecha: formatFecha(ev.created_at),
        tipo: tipo.includes('incoming') ? 'entrante' : 'saliente',
        texto: String(texto).substring(0, 1000),
        canal: { id: 'chat', label: 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' },
        fuente: 'evento'
      });
    });

    // ── PROBE 3: /inbox endpoints ──
    var inboxResp = await kfetch('/inbox?limit=5');
    debug.probes.push({
      name: 'inbox_root',
      status: inboxResp._status,
      embeddedKeys: inboxResp._embedded ? Object.keys(inboxResp._embedded) : [],
      raw: inboxResp._raw || null
    });

    // ── PROBE 4: Talk individual con chat_id ──
    var talkDetail = await kfetch('/talks/229776');
    debug.probes.push({
      name: 'talk_229776_direct',
      status: talkDetail._status,
      keys: talkDetail ? Object.keys(talkDetail).filter(function(k){return k!=='_links';}) : [],
      chat_id: talkDetail.chat_id,
      origin: talkDetail.origin,
      source_id: talkDetail.source_id
    });

    // ── PROBE 5: /sources para ver qué canales hay ──
    var sources = await kfetch('/sources?limit=50');
    var srcList = (sources && sources._embedded && sources._embedded.sources) || [];
    debug.probes.push({
      name: 'sources',
      status: sources._status,
      count: srcList.length,
      list: srcList.map(function(s) { return { id: s.id, name: s.name, type: s.type }; })
    });

    // ── PROBE 6: /calls (llamadas) ──
    var callsResp = await kfetch('/calls?filter[lead_id]=' + lead.id + '&limit=20');
    var callsList = (callsResp && callsResp._embedded && callsResp._embedded.calls) || [];
    debug.probes.push({
      name: 'calls',
      status: callsResp._status,
      count: callsList.length,
      sample: callsList.slice(0, 2)
    });

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
