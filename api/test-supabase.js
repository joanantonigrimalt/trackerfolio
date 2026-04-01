module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({
        error: 'Missing Supabase credentials',
        hasUrl: !!supabaseUrl,
        hasKey: !!supabaseKey
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Try to list tables
    const { data, error } = await supabase
      .from('profiles')
      .select('count', { count: 'exact', head: true });

    return res.status(200).json({
      status: 'ok',
      supabase: {
        url: supabaseUrl.split('://')[1]?.split('.')[0] || 'unknown',
        connected: !error,
        error: error?.message || null
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
      error: error.message,
      type: error.constructor.name
    });
  }
};
