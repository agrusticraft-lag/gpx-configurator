export default async function handler(req, res) {
  const { south, north, west, east, demtype = "COP30" } = req.query;

  if (!south || !north || !west || !east) {
    return res.status(400).json({ error: "Missing bbox parameters" });
  }

  const apiKey = process.env.OPENTOPO_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Missing OpenTopography API key" });
  }

  const url =
    `https://portal.opentopography.org/API/globaldem` +
    `?demtype=${demtype}` +
    `&south=${south}` +
    `&north=${north}` +
    `&west=${west}` +
    `&east=${east}` +
    `&outputFormat=AAIGrid` +
    `&API_Key=${apiKey}`;

  try {
    const response = await fetch(url);
    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).send(text);
    }

    res.setHeader("Content-Type", "text/plain");
    return res.status(200).send(text);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
