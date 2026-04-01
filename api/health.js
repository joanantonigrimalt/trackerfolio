module.exports = async (req, res) => {
  try {
    // If DB_PROXY_URL is set, test proxy connection instead of direct DB
    if (process.env.DB_PROXY_URL) {
      const proxyUrl = `${process.env.DB_PROXY_URL}/health`;
      const response = await fetch(proxyUrl, { timeout: 5000 });
      const data = await response.json();

      return res.status(200).json({
        status: 'ok',
        message: 'API connected via DB Proxy',
        mode: 'proxy',
        proxyUrl: process.env.DB_PROXY_URL,
        database: {
          connected: data.status === 'ok'
        },
        timestamp: new Date().toISOString()
      });
    }

    // Direct DB connection (fallback)
    const mysql = require('mysql2/promise');

    const pool = mysql.createPool({
      host:     process.env.MYSQL_HOST || 'localhost',
      user:     process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 1,
      charset: 'utf8mb4',
    });

    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();

    res.status(200).json({
      status: 'ok',
      message: 'API and Database connected (direct)',
      mode: 'direct',
      database: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        connected: true
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      mode: process.env.DB_PROXY_URL ? 'proxy' : 'direct',
      database: {
        connected: false
      }
    });
  }
};
