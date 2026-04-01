module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');

    // Validate environment variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({
        error: 'Server misconfigured: Missing Supabase credentials',
        details: 'SUPABASE_URL or SUPABASE_ANON_KEY not set'
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { action, email, password, name } = req.body;

    if (!action || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields: action, email, password' });
    }

    if (action === 'signup') {
      if (!name) {
        return res.status(400).json({ error: 'Missing required field: name' });
      }

      const { data, error } = await supabase.auth.signUpWithPassword({
        email,
        password,
        options: {
          data: { full_name: name }
        }
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      // Try to create profile, but don't fail if it doesn't work
      try {
        if (data.user) {
          await supabase.from('profiles').insert([
            {
              id: data.user.id,
              email: email,
              full_name: name,
            }
          ]);
        }
      } catch (profileError) {
        console.log('[auth] Profile insert error:', profileError.message);
        // Don't fail signup if profile creation fails
      }

      return res.status(200).json({
        status: 'ok',
        message: 'Usuario registrado',
        user: data.user ? { id: data.user.id, email: data.user.email } : null
      });

    } else if (action === 'signin') {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return res.status(401).json({ error: error.message });
      }

      return res.status(200).json({
        status: 'ok',
        message: 'Login exitoso',
        user: data.user ? { id: data.user.id, email: data.user.email } : null,
        session: data.session
      });

    } else {
      return res.status(400).json({ error: `Invalid action: ${action}` });
    }

  } catch (error) {
    console.error('[auth] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
