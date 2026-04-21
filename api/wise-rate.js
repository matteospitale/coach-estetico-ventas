export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.WISE_API_TOKEN;
  if (!token) return res.status(500).json({ error: 'Wise token not configured' });

  const { source, target, date } = req.query;
  if (!source || !target || !date) return res.status(400).json({ error: 'Missing params' });

  try {
    // Get rate for specific date (time=date at noon to get that day's rate)
    const url = `https://api.transferwise.com/v1/rates?source=${source}&target=${target}&time=${date}T12:00:00Z`;
    const response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    // Returns array, first item is the rate
    if (Array.isArray(data) && data.length > 0) {
      return res.status(200).json({ rate: data[0].rate, source, target, date });
    }
    return res.status(404).json({ error: 'No rate found for that date' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
