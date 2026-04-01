module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      return res.status(500).json({ error: 'Supabase URL not configured' });
    }

    // Extract the path after /auth/
    const path = req.url.replace(/^\/auth/, '');
    const targetUrl = `${supabaseUrl}${path}`;

    // Prepare headers
    const headers = {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_ANON_KEY,
      ...Object.fromEntries(
        Object.entries(req.headers).filter(([key]) =>
          !['host', 'connection', 'content-length'].includes(key.toLowerCase())
        )
      )
    };

    // Forward the request to Supabase
    const options = {
      method: req.method,
      headers
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      options.body = JSON.stringify(req.body || {});
    }

    const response = await fetch(targetUrl, options);
    const data = await response.text();

    // Copy response headers
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // Send response
    res.end(data);

  } catch (error) {
    console.error('[auth-proxy] Error:', error);
    res.status(500).json({
      error: 'Proxy error',
      message: error.message
    });
  }
};
