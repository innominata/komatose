import { integer, primaryKey, real, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	role: text('role').notNull(),
	createdBy: text('created_by').references((): AnySQLiteColumn => users.id, { onDelete: 'set null' }),
	settings: text('settings').notNull().default('{}'),
	createdAt: integer('created_at').notNull()
});

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: integer('expires_at').notNull(),
	lastSeenAt: integer('last_seen_at').notNull().default(0)
});

export const series = sqliteTable('series', {
	id: text('id').primaryKey(),
	slug: text('slug').notNull().unique(),
	title: text('title').notNull(),
	notes: text('notes').notNull().default(''),
	glossary: text('glossary').notNull().default('[]'),
	credits: text('credits').notNull().default('{}'),
	createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const seriesMembers = sqliteTable(
	'series_members',
	{
		seriesId: text('series_id')
			.notNull()
			.references(() => series.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: integer('created_at').notNull()
	},
	(t) => [primaryKey({ columns: [t.seriesId, t.userId] })]
);

export const episodes = sqliteTable('episodes', {
	id: text('id').primaryKey(),
	seriesId: text('series_id')
		.notNull()
		.references(() => series.id, { onDelete: 'cascade' }),
	slug: text('slug').notNull(),
	title: text('title').notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	status: text('status').notNull().default('raws'),
	numberingStale: integer('numbering_stale', { mode: 'boolean' }).notNull().default(true),
	revision: integer('revision').notNull().default(0),
	/** Unguessable public strip-preview link. Null = preview off. */
	previewToken: text('preview_token').unique(),
	glossary: text('glossary').notNull().default('[]'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const images = sqliteTable('images', {
	id: text('id').primaryKey(),
	episodeId: text('episode_id')
		.notNull()
		.references(() => episodes.id, { onDelete: 'cascade' }),
	pageNumber: integer('page_number'),
	captionRevision: integer('caption_revision').notNull().default(0),
	dpi: real('dpi').notNull().default(72),
	filename: text('filename').notNull(),
	originalName: text('original_name').notNull(),
	sortOrder: integer('sort_order').notNull().default(0),
	width: integer('width').notNull(),
	height: integer('height').notNull(),
	caption: text('caption').notNull().default(''),
	role: text('role').notNull().default('page'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull().default(0)
});

export const lines = sqliteTable('lines', {
	id: text('id').primaryKey(),
	episodeId: text('episode_id')
		.notNull()
		.references(() => episodes.id, { onDelete: 'cascade' }),
	imageId: text('image_id').references(() => images.id, { onDelete: 'set null' }),
	source: text('source').notNull().default(''),
	ocrConfidence: real('ocr_confidence'),
	sourceState: text('source_state').notNull().default('unreadable'),
	ignoreReason: text('ignore_reason').notNull().default(''),
	revision: integer('revision').notNull().default(0),
	body: text('body').notNull(),
	lineType: text('line_type').notNull().default('plain'),
	status: text('status').notNull().default('none'),
	placed: integer('placed', { mode: 'boolean' }).notNull().default(false),
	/** True = black lettering (light bubble). Null = not yet sampled. */
	invert: integer('invert', { mode: 'boolean' }),
	x: real('x'),
	y: real('y'),
	w: real('w'),
	h: real('h'),
	sidebarX: real('sidebar_x'),
	sidebarY: real('sidebar_y'),
	sidebarW: real('sidebar_w'),
	sidebarH: real('sidebar_h'),
	sortOrder: integer('sort_order').notNull().default(0),
	createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
	updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
	updatedAt: integer('updated_at').notNull()
});

export const comments = sqliteTable('comments', {
	revision: integer('revision').notNull().default(0),
	id: text('id').primaryKey(),
	lineId: text('line_id')
		.notNull()
		.references(() => lines.id, { onDelete: 'cascade' }),
	userId: text('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	body: text('body').notNull(),
	/** True = this comment is the proofreader's replacement text for the sticky. */
	correction: integer('correction', { mode: 'boolean' }).notNull().default(false),
	createdAt: integer('created_at').notNull()
});

export const activity = sqliteTable('activity', {
	id: text('id').primaryKey(),
	seriesId: text('series_id').references(() => series.id, { onDelete: 'cascade' }),
	episodeId: text('episode_id').references(() => episodes.id, { onDelete: 'cascade' }),
	userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
	action: text('action').notNull(),
	payload: text('payload').notNull().default('{}'),
	createdAt: integer('created_at').notNull()
});
