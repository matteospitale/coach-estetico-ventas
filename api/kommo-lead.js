module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: 'Kommo token no configurado en Vercel' });

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });

  const BASE = 'https://coachestetico.kommo.com/api/v4';
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json'
  };

  try {
    var lead = null;
    var isId = /^\d+$/.test(q.trim());

    if (isId) {
      var r = await fetch(BASE + '/leads/' + q.trim(), { headers: headers });
      var text = await r.text();
      if (!text || text.trim() === '') return res.status(404).json({ error: 'Lead no encontrado' });
      var data = JSON.parse(text);
      if (!data.id) return res.status(404).json({ error: 'Lead ' + q + ' no encontrado' });
      lead = data;
    } else {
      var r2 = await fetch(BASE + '/leads?query=' + encodeURIComponent(q.trim()) + '&limit=1', { headers: headers });
      var text2 = await r2.text();
      if (!text2 || text2.trim() === '') return res.status(404).json({ error: 'Sin resultados para: ' + q });
      var data2 = JSON.parse(text2);
      var leads = data2 && data2._embedded && data2._embedded.leads;
      if (leads && leads.length > 0) lead = leads[0];
    }

    if (!lead) return res.status(404).json({ error: 'Lead "' + q + '" no encontrado en Kommo' });

    var customFields = lead.custom_fields_values || [];
    function getField(name) {
      var f = customFields.find(function(f) { return (f.field_name || '').toLowerCase() === name.toLowerCase(); });
      return f ? (f.values && f.values[0] && f.values[0].value || '') : '';
    }

    var notas = [];
    try {
      var notesR = await fetch(BASE + '/leads/' + lead.id + '/notes?limit=50&order[id]=asc', { headers: headers });
      var notesText = await notesR.text();
      if (notesText && notesText.trim() !== '') {
        var notesData = JSON.parse(notesText);
        var notesList = notesData && notesData._embedded && notesData._embedded.notes || [];
        notas = notesList
          .filter(function(n) {
            var t = n.note_type;
            return t === 'common' || t === 'inbox_message' || t === 'outbox_message' ||
                   t === 4 || t === 12 || t === 13 || t === 'service_message';
          })
          .map(function(n) {
            var d = new Date(n.created_at * 1000);
            var fecha = d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
                        ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
            var tipo = (n.note_type === 'inbox_message' || n.note_type === 4) ? 'entrante' : 'saliente';
            var texto = (n.params && (n.params.text || n.params.service)) || n.text || '';
            return { fecha: fecha, tipo: tipo, texto: String(texto).substring(0, 600) };
          })
          .filter(function(n) { return n.texto.length > 2; });
      }
    } catch(e) { /* notas stays empty */ }

    var diasSinActividad = lead.updated_at
      ? Math.floor((Math.floor(Date.now() / 1000) - lead.updated_at) / 86400)
      : 0;

    return res.status(200).json({
      lead: {
        id: lead.id,
        nombre: lead.name || 'Sin nombre',
        etapa: String(lead.status_id || '—'),
        interes: getField('Interes') || getField('Interés') || '',
        tags: (lead.tags || []).map(function(t) { return t.name; }).join(', '),
        dias_sin_actividad: diasSinActividad,
        presupuesto: lead.price || 0
      },
      notas: notas
    });

  } catch(e) {
    return res.status(500).json({ error: 'Error Kommo: ' + e.message });
  }
};
