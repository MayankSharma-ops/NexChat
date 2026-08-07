import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Remove channel_binding param if present (not supported by all pg versions)
let connectionString = process.env.DATABASE_URL || '';
const url = new URL(connectionString);
url.searchParams.delete('channel_binding');
connectionString = url.toString();

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

pool.on('error', (err) => console.error('PG pool error:', err));

// Test connection on startup
pool.query('SELECT NOW()')
  .then(() => console.log('Database connected'))
  .catch((err) => console.error('Database connection failed:', err.message));

export default pool;
