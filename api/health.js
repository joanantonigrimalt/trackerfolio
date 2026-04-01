module.exports = async (req, res) => {
  try {
    // Supabase mode
    if (process.env.SUPABASE_URL) {
      const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
        headers: {
          'apikey': process.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`
        },
        timeout: 5000
      });

      return res.status(200).json({
        status: 'ok',
        message: 'API connected to Supabase',
        mode: 'supabase',
        database: {
          connected: response.ok
        },
        timestamp: new Date().toISOString()
      });
    }

    // Fallback
    res.status(200).json({
      status: 'ok',
      message: 'API is running',
      mode: 'default',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      mode: 'supabase',
      database: {
        connected: false
      }
    });
  }
};
