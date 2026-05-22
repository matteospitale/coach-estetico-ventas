// Vercel serverless function — proxy para Kommo API
// Evita CORS: el browser llama a /api/kommo (mismo dominio) y este script llama a Kommo server-to-server.

const KOMMO_TOKEN = process.env.KOMMO_TOKEN ||
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6Ijc1YjNhOTNjNzYwZjQxZWYyYTg1OWIyZmYxMGY4ZGUyMGE5ZjY4N2I0MzlhZmNlZTU4MjkzMzk3YzU5ZTM2ZmQ4MjUwODUwYTQ0NDBkYmY5In0.eyJhdWQiOiI2NTIwZDRjMi01NmZlLTRiZGYtYjgyMC1lMTA0M2U4ZDI5MTkiLCJqdGkiOiI3NWIzYTkzYzc2MGY0MWVmMmE4NTliMmZmMTBmOGRlMjBhOWY2ODdiNDM5YWZjZWU1ODI5MzM5N2M1OWUzNmZkODI1MDg1MGE0NDQwZGJmOSIsImlhdCI6MTc3Njc4NzI1OSwibmJmIjoxNzc2Nzg3MjU5LCJleHAiOjE5MzQ0OTYwMDAsInN1YiI6IjEzNzYxNDA4IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjI5NzAwMjQ4LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiNzVlZTQ1N2UtMjdlMS00MzBhLTg4YjQtZjJhZTcwMGY0MGQxIiwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.mDQekm9QWyoe5_F5G0xYsNHhv0G_P9_TErG6wj08i1-alm3OGmnTr1FwyyzsLWkg8h_SkdditZDtTUmDu7ES1usiCS90XRPFUBY4MvBYbWjBpn2m_qt3x7dVm4Fgycmyzu1_ukckxm9wU08xA5ivyAoTT4gWfzaG5r9pw-Ei3-U_cmSR6qrcPUq-PZZ6ErjNffOZgUHUitcmcC3LatyoQ6wvtfkO8YHQPWobR1VP0kVgqlHjzqnO7yWvopwIsW2YGQPp95CafUzxQB9kuxtffjdF2uX-eqJgkPi7WCFpL1IqQJ3GyJX4WdlIWP4bD-f8SVud5DwHcFPLM0BfBUlhPg';

module.exports = async function handler(req, res) {
  // CORS headers (por si se accede desde otro origen)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const path = req.query.path || '';
  if (!path.startsWith('/api/v4/')) {
    return res.status(400).json({ error: 'path invalido' });
  }

  const kommoUrl = 'https://api-g.kommo.com' + path;

  try {
    const r = await fetch(kommoUrl, {
      headers: { 'Authorization': 'Bearer ' + KOMMO_TOKEN }
    });
    const data = await r.json();
    // Cache de 60s para no saturar la API de Kommo
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
