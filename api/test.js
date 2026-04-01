module.exports = (req, res) => {
  res.status(200).json({
    message: 'API Test Endpoint Works!',
    timestamp: new Date().toISOString(),
    env: {
      mysql_host: process.env.MYSQL_HOST,
      mysql_user: process.env.MYSQL_USER,
      mysql_db: process.env.MYSQL_DATABASE,
      api_base_url: process.env.API_BASE_URL
    }
  });
};
