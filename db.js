require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'club_liquor_shop',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // return dates as plain text
});

// Use Kenya time (EAT) for every connection so receipts show the right time
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+03:00'");
});

module.exports = pool;
