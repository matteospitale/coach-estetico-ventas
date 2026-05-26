module.exports = async function handler(req, res) {
  return res.status(410).json({ error: 'Endpoint removido' });
};
