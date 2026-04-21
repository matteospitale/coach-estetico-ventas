export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.KOMMO_TOKEN;
  if (!token) return res.status(500).json({ error: 'Kommo token no configurado' });

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });

  const BASE = 'https://coachestetico.kommo.com/api/v4';
  const headers = { 'Authorization': 'Bearer ' + token };

  try {
    // Search by ID or name
    const isId = /^\d+$/.test(q.trim());
    let lead = null;

    if (isId) {
      const r = await fetch(`${BASE}/leads/${q}?with=contacts`, { headers });
      if (r.ok) lead = await r.json();
    } else {
      const r = await fetch(`${BASE}/leads?query=${encodeURIComponent(q)}&limit=1&with=contacts`, { headers });
      if (r.ok) {
        const data = await r.json();
        const leads = data?._embedded?.leads;
        if (leads && leads.length > 0) lead = leads[0];
      }
    }

    if (!lead) return res.status(404).json({ error: `Lead "${q}" no encontrado en Kommo` });

    // Get custom fields values
    const customFields = lead.custom_fields_values || [];
    const getField = (name) => {
      const f = customFields.find(f => f.field_name === name);
      return f ? (f.values[0]?.value || '') : '';
    };

    // Get notes (conversation)
    const notesResp = await fetch(`${BASE}/leads/${lead.id}/notes?limit=50&order[id]=desc`, { headers });
    let notas = [];
    if (notesResp.ok) {
      const notesData = await notesResp.json();
      const notesList = notesData?._embedded?.notes || [];
      notas = notesList
        .filter(n => n.note_type === 'common' || n.note_type === 'inbox_message' || n.note_type === 'outbox_message' || n.note_type === 4 || n.note_type === 'service_message')
        .map(n => {
          const fecha = new Date(n.created_at * 1000).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
          const tipo = n.note_type === 'inbox_message' || n.note_type === 4 ? 'entrante' : 'saliente';
          const texto = n.params?.text || n.params?.service || n.text || '';
          return { fecha, tipo, texto: texto.substring(0, 500) };
        })
        .filter(n => n.texto.length > 0);
    }

    // Calculate days without activity
    const diasSinActividad = lead.updated_at
      ? Math.floor((Date.now() / 1000 - lead.updated_at) / 86400)
      : 0;

    return res.status(200).json({
      lead: {
        id: lead.id,
        nombre: lead.name || 'Sin nombre',
        etapa: lead.status_id || '—',
        interes: getField('Interes') || getField('Interés'),
        tags: lead.tags?.map(t => t.name).join(', ') || '',
        dias_sin_actividad: diasSinActividad,
        presupuesto: lead.price || 0,
      },
      notas
    });

  } catch (e) {
    return res.status(500).json({ error: 'Error al conectar con Kommo: ' + e.message });
  }
}
