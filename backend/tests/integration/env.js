// Must be imported FIRST by integration tests: isolates them in a throwaway Postgres schema
// so they never read or modify real data. The schema is created, migrated and dropped by the test.
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_SCHEMA = `monica_test_${randomBytes(5).toString('hex')}`;
if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
  process.env.AUTH_SECRET = randomBytes(48).toString('base64url');
}
process.env.ALLOWED_ORIGINS = 'http://allowed.test';
