module.exports = async (req, res) => {
  try {
    const mysql = require('mysql2/promise');

    // Test DB connection
    const pool = mysql.createPool({
      host:     process.env.MYSQL_HOST,
      user:     process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 1,
      charset: 'utf8mb4',
    });

    const connection = await pool.getConnection();
    const [result] = await connection.query('SELECT 1');
    connection.release();

    res.status(200).json({
      status: 'ok',
      message: 'API and Database connected',
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
      database: {
        host: process.env.MYSQL_HOST,
        database: process.env.MYSQL_DATABASE,
        connected: false
      }
    });
  }
};
