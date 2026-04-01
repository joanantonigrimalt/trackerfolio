// Finasset Auth Shim - Load Supabase SDK and expose globally
(function() {
  // Create initialization function
  window._initSupabaseAuth = async function() {
    try {
      // Check if already initialized
      if (window._supabaseInitialized) return window.supabase;

      // Fetch config from server
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error('Failed to fetch config');
      const config = await response.json();

      // Dynamically load Supabase SDK
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.38.0/+esm');

      // Create and expose global supabase object
      window.supabase = {
        createClient: createClient,
        config: config
      };

      window._supabaseInitialized = true;
      console.log('[finasset-auth] Initialized successfully');
      return window.supabase;
    } catch(e) {
      console.error('[finasset-auth] Init error:', e);
      window._sbInitErr = e.message;
      throw e;
    }
  };

  // Also expose a simpler global alias
  window._sbAuthLoaded = true;
})();

