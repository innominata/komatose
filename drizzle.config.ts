import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL || 'data/scan.db';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	dialect: 'sqlite',
	dbCredentials: { url },
	verbose: true,
	strict: true
});
