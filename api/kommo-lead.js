export default async function handler(req, res) {
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
    let lead = null;
    const isId = /^\d+$/.test(q.trim());

    if (isId) {
      // Fetch by ID directly
      const r = await fetch(`${BASE}/leads/${q.trim()}`, { headers });
      const text = await r.text();
      if (!text || text.trim() === '') return res.status(404).json({ error: 'Lead no encontrado (respuesta vacía)' });
      const data = JSON.parse(text);
      if (data.status === 0 || data._embedded === undefined && !data.id) {
        return res.status(404).json({ error: 'Lead ' + q + ' no encontrado' });
      }
      lead = data.id ? data : null;
    } else {
      // Search by name
      const r = await fetch(`${BASE}/leads?query=${encodeURIComponent(q.trim())}&limit=1`, { headers });
      const text = await r.text();
      if (!text || text.trim() === '') return res.status(404).json({ error: 'Sin resultados para: ' + q });
      const data = JSON.parse(text);
      const leads = data?._embedded?.leads;
      if (leads && leads.length > 0) lead = leads[0];
    }

    if (!lead) return res.status(404).json({ error: 'Lead "' + q + '" no encontrado en Kommo' });

    // Get custom fields
    const customFields = lead.custom_fields_values || [];
    const getField = (name) => {
      const f = customFields.find(f => (f.field_name||'').toLowerCase() === name.toLowerCase());
      return f ? (f.values?.[0]?.value || '') : '';
    };

    // Get notes/conversation
    let notas = [];
    try {
      const notesR = await fetch(`${BASE}/leads/${lead.id}/notes?limit=50&order[id]=asc`, { headers });
      const notesText = await notesR.text();
      if (notesText && notesText.trim() !== '') {
        const notesData = JSON.parse(notesText);
        const notesList = notesData?._embedded?.notes || [];
        notas = notesList
          .filter(n => {
            const t = n.note_type;
            return t === 'common' || t === 'inbox_message' || t === 'outbox_message' || 
                   t === 4 || t === 12 || t === 13 || t === 'service_message';
          })
          .map(n => {
            const d = new Date(n.created_at * 1000);
            const fecha = d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' }) + 
                          ' ' + d.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
            const tipo = (n.note_type === 'inbox_message' || n.note_type === 4) ? 'entrante' : 'saliente';
            const texto = n.params?.text || n.params?.service || n.text || '';
            return { fecha, tipo, texto: String(texto).substring(0, 600) };
          })
          .filter(n => n.texto.length > 2);
    } catch(e) {
      // notas stays empty, no crash
    }

    // Days without activity
    const diasSinActividad = lead.updated_at
      ? Math.floor((Math.floor(Date.now() / 1000) - lead.updated_at) / 86400)
      : 0;

    // Get status name via pipeline/status lookup (optional, just use id if fails)
    let etapaNombre = String(lead.status_id || '—');
    try {
      const pipR = await fetch(`${BASE}/leads/pipelines`, { headers });
      const pipText = await pipR.text();
      if (pipText) {
        const pipData = JSON.parse(pipText);
        const pipelines = pipData?._embedded?.pipelines || [];
        for (const pip of pipelines) {
          const statuses = pip._embedded?.statuses || [];
          const found = statuses.find(s => s.id === lead.status_id);
          if (found) { etapaNombre = found.name; break; }
        }
      }
    } catch(e) { /* keep numeric id */ }

    return res.status(200).json({
      lead: {
        id: lead.id,
        nombre: lead.name || 'Sin nombre',
        etapa: etapaNombre,
        interes: getField('Interes') || getField('Interés') || '',
        tags: (lead.tags || []).map(t => t.name).join(', '),
        dias_sin_actividad: diasSinActividad,
        presupuesto: lead.price || 0,
      },
      notas
    });

  } catch(e) {
    return res.status(500).json({ error: 'Error Kommo: ' + e.message });
  }
}
