module.exports = (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Show environment status
  res.status(200).json({
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL ? '✓ SET' : '✗ MISSING',
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? '✓ SET' : '✗ MISSING',
      NODE_ENV: process.env.NODE_ENV
    },
    supabaseUrl: process.env.SUPABASE_URL || 'NOT SET',
    timestamp: new Date().toISOString()
  });
};
