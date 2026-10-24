// Run once after creating the tables:  npm run seed
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

(async () => {
  try {
    const users = [
      ['boss', 'boss123', 'boss'],
      ['cashier', 'cashier123', 'cashier'],
    ];
    for (const [username, password, role] of users) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'INSERT IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        [username, hash, role]
      );
    }
    for (const t of ['Beer', 'Whisky', 'Vodka', 'Gin', 'Brandy', 'Wine', 'Soft drink']) {
      await pool.query('INSERT IGNORE INTO product_types (name) VALUES (?)', [t]);
    }
    console.log('Done. Logins created:');
    console.log('  boss    / boss123');
    console.log('  cashier / cashier123');
    console.log('Change these passwords before using the system for real.');
  } catch (err) {
    console.error('Seed failed:', err.message);
  } finally {
    process.exit(0);
  }
})();
