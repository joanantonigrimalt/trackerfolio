module.exports = async (req, res) => {
  const { createClient } = await import('@supabase/supabase-js');

  // Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  try {
    const { action, email, password, name } = req.body;

    if (action === 'signup') {
      // Registrar usuario
      const { data, error } = await supabase.auth.signUpWithPassword({
        email,
        password,
      });

      if (error) {
        return res.status(400).json({ error: error.message });
      }

      // Crear perfil
      await supabase.from('profiles').insert([
        {
          id: data.user.id,
          email: email,
          full_name: name,
        }
      ]);

      res.status(200).json({
        status: 'ok',
        message: 'Usuario registrado',
        user: { id: data.user.id, email: data.user.email }
      });

    } else if (action === 'signin') {
      // Login
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        return res.status(401).json({ error: error.message });
      }

      res.status(200).json({
        status: 'ok',
        message: 'Login exitoso',
        user: { id: data.user.id, email: data.user.email },
        session: data.session
      });

    } else {
      res.status(400).json({ error: 'Action no válido' });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
