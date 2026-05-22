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
    if (!t || !t.trim()) return null;
    try { return JSON.parse(t); } catch(e) { return null; }
  }

  function formatFecha(ts) {
    var d = new Date((ts || 0) * 1000);
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
           ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  }

  // Detectar canal a partir del talk
  function detectarCanal(talk) {
    // Intentar desde _embedded.source o campos directos
    var src = (talk._embedded && talk._embedded.source) || {};
    var tipo = (src.type || src.code || talk.source_code || talk.channel_type || '').toLowerCase();
    var nombre = src.name || src.origin || talk.source_name || '';

    if (tipo.includes('instagram')) return { id: 'instagram', label: 'Instagram', color: '#C13584', bg: 'rgba(193,53,132,0.10)' };
    if (tipo.includes('facebook') || tipo.includes('fb')) return { id: 'facebook', label: 'Facebook', color: '#1877F2', bg: 'rgba(24,119,242,0.10)' };
    if (tipo.includes('telegram')) return { id: 'telegram', label: 'Telegram', color: '#229ED9', bg: 'rgba(34,158,217,0.10)' };
    if (tipo.includes('whatsapp') || tipo.includes('waba')) {
      var num = nombre.replace(/[^0-9+]/g, '').trim();
      return { id: 'whatsapp', label: 'WhatsApp' + (num ? ' ' + num : ''), color: '#25D366', bg: 'rgba(37,211,102,0.10)' };
    }
    // Si no detectamos por tipo, intentar por nombre
    var nb = nombre.toLowerCase();
    if (nb.includes('instagram')) return { id: 'instagram', label: nombre || 'Instagram', color: '#C13584', bg: 'rgba(193,53,132,0.10)' };
    if (nb.includes('facebook') || nb.includes('fb messenger')) return { id: 'facebook', label: nombre || 'Facebook', color: '#1877F2', bg: 'rgba(24,119,242,0.10)' };
    if (nb.includes('whatsapp') || nb.includes('wapp')) {
      var num2 = nombre.replace(/[^0-9+]/g, '').trim();
      return { id: 'whatsapp', label: 'WhatsApp' + (num2 ? ' ' + num2 : ''), color: '#25D366', bg: 'rgba(37,211,102,0.10)' };
    }
    if (nb.includes('telegram')) return { id: 'telegram', label: nombre || 'Telegram', color: '#229ED9', bg: 'rgba(34,158,217,0.10)' };
    // Canal desconocido pero es un chat
    return { id: 'chat', label: nombre || 'Chat', color: '#5a504a', bg: 'rgba(90,80,74,0.09)' };
  }

  function textoMensaje(content) {
    if (!content) return '';
    var text = content.text || content.body || '';
    if (text) return text;
    switch (content.type) {
      case 'image':  return '🖼 Imagen';
      case 'video':  return '🎥 Video';
      case 'voice':  return '🎤 Audio';
      case 'file':   return '📎 Archivo';
      case 'sticker':return '🖼 Sticker';
      default: return content.type ? '[' + content.type + ']' : '';
    }
  }

  try {
    // ── 1. Buscar lead ──
    var lead = null;
    if (/^\d+$/.test(q.trim())) {
      var d = await kfetch('/leads/' + q.trim());
      if (d && d.id) lead = d;
    } else {
      var d2 = await kfetch('/leads?query=' + encodeURIComponent(q.trim()) + '&limit=1');
      var arr = d2 && d2._embedded && d2._embedded.leads;
      if (arr && arr.length) lead = arr[0];
    }
    if (!lead) return res.status(404).json({ error: 'Lead "' + q + '" no encontrado' });

    var items = []; // timeline unificado

    // ── 2. Todos los talks del lead (WhatsApp, Instagram, Facebook, etc.) ──
    try {
      var talksData = await kfetch('/talks?filter[entity_id][]=' + lead.id + '&filter[entity_type][]=leads&limit=50');
      var talks = (talksData && talksData._embedded && talksData._embedded.talks) || [];

      // Fetch mensajes de cada talk en paralelo (max 10 talks)
      var talkPromises = talks.slice(0, 10).map(async function(talk) {
        var canal = detectarCanal(talk);
        var msgsData = await kfetch('/messages?filter[talk_id][]=' + talk.id + '&limit=250');
        var msgs = (msgsData && msgsData._embedded && msgsData._embedded.messages) || [];
        return msgs.map(function(m) {
          var texto = textoMensaje(m.content);
          if (!texto) return null;
          var authorType = (m.author && m.author.type) || 'user';
          return {
            ts:     m.created_at || 0,
            fecha:  formatFecha(m.created_at),
            tipo:   authorType === 'contact' ? 'entrante' : 'saliente',
            texto:  String(texto).substring(0, 1000),
            canal:  canal,
            fuente: 'chat'
          };
        }).filter(Boolean);
      });

      var talkResults = await Promise.all(talkPromises);
      talkResults.forEach(function(msgs) { items = items.concat(msgs); });

    } catch(e) { /* talks no disponibles */ }

    // ── 3. Notas manuales del lead ──
    try {
      var notesData = await kfetch('/leads/' + lead.id + '/notes?limit=250&order[id]=asc');
      var notesList = (notesData && notesData._embedded && notesData._embedded.notes) || [];
      notesList.forEach(function(n) {
        var texto = '';
        if (n.params) texto = n.params.text || n.params.service || n.params.body || n.params.message || '';
        if (!texto && n.text) texto = n.text;
        if (!texto || texto.trim().length < 2) return;

        var icono = n.note_type === 25 ? '📞 Llamada ent.' :
                    n.note_type === 26 ? '📞 Llamada sal.' :
                    n.note_type === 12 ? '📎 Archivo' : '';

        items.push({
          ts:     n.created_at || 0,
          fecha:  formatFecha(n.created_at),
          tipo:   (n.created_by || 0) === 0 ? 'entrante' : 'saliente',
          texto:  (icono ? icono + ' · ' : '') + String(texto).substring(0, 1000),
          canal:  { id: 'nota', label: 'Nota', color: '#9a8f87', bg: 'rgba(154,143,135,0.10)' },
          fuente: 'nota'
        });
      });
    } catch(e) { /* notas no disponibles */ }

    // ── 4. Ordenar todo por timestamp ──
    items.sort(function(a, b) { return a.ts - b.ts; });

    // ── Info del lead ──
    var cf = lead.custom_fields_values || [];
    function getField(name) {
      var f = cf.find(function(x) { return (x.field_name || '').toLowerCase() === name.toLowerCase(); });
      return f ? (f.values && f.values[0] && f.values[0].value || '') : '';
    }

    return res.status(200).json({
      lead: {
        id:               lead.id,
        nombre:           lead.name || 'Sin nombre',
        etapa:            String(lead.status_id || '—'),
        interes:          getField('Interes') || getField('Interés') || '',
        tags:             (lead.tags || []).map(function(t) { return t.name; }).join(', '),
        dias_sin_actividad: lead.updated_at ? Math.floor((Math.floor(Date.now()/1000) - lead.updated_at) / 86400) : 0,
        presupuesto:      lead.price || 0
      },
      total: items.length,
      notas: items
    });

  } catch(e) {
    return res.status(500).json({ error: 'Error Kommo: ' + e.message });
  }
};
