// PostgreSQL Database utilities for Ad Vault (Railway deployment)
import pg from 'pg';
const { Pool } = pg;

let pool;

// Initialize database connection pool
export async function initDatabase() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query('SELECT NOW()');
    console.log('Connected to PostgreSQL database');

    // Run migrations
    await runMigrations(client);
  } finally {
    client.release();
  }
}

// Run database migrations
async function runMigrations(client) {
  await client.query(`
    -- Ads table
    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      video_src TEXT NOT NULL,
      source TEXT NOT NULL,
      creator TEXT,
      product TEXT,
      vertical TEXT,
      type TEXT,
      hook_text_overlay TEXT,
      hook_spoken TEXT,
      full_transcript TEXT,
      why_summary TEXT,
      why_key_lesson TEXT,
      tags JSONB DEFAULT '[]',
      date_added TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Ad tactics (one-to-many with ads)
    CREATE TABLE IF NOT EXISTS ad_tactics (
      id SERIAL PRIMARY KEY,
      ad_id TEXT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER DEFAULT 0
    );

    -- Ad shots (one-to-many with ads)
    CREATE TABLE IF NOT EXISTS ad_shots (
      id SERIAL PRIMARY KEY,
      ad_id TEXT NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
      shot_number INTEGER NOT NULL,
      start_time REAL,
      end_time REAL,
      timestamp TEXT,
      type TEXT DEFAULT 'video',
      thumbnail TEXT,
      description TEXT,
      transcript TEXT,
      text_overlay TEXT,
      purpose TEXT
    );

    -- Images table (Image Vault)
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      title TEXT,
      image_src TEXT NOT NULL,
      source TEXT,
      creator TEXT,
      prompt TEXT,
      raw_prompt TEXT,
      tags JSONB DEFAULT '[]',
      date_added TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Tweets table (Tweet Vault)
    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      tags JSONB DEFAULT '[]',
      added_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_ads_date ON ads(date_added);
    CREATE INDEX IF NOT EXISTS idx_ads_creator ON ads(creator);
    CREATE INDEX IF NOT EXISTS idx_ad_shots_ad_id ON ad_shots(ad_id);
    CREATE INDEX IF NOT EXISTS idx_ad_tactics_ad_id ON ad_tactics(ad_id);
    CREATE INDEX IF NOT EXISTS idx_images_date ON images(date_added);
    CREATE INDEX IF NOT EXISTS idx_tweets_date ON tweets(added_at);
  `);
  console.log('Database migrations complete');
}

// Helper to get pool
function getPool() {
  if (!pool) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return pool;
}

// ==================== ADS ====================

export async function getAllAds() {
  const db = getPool();
  const ads = await db.query(`
    SELECT * FROM ads ORDER BY date_added DESC
  `);

  const results = [];
  for (const ad of ads.rows) {
    const tactics = await db.query(`
      SELECT name, description FROM ad_tactics
      WHERE ad_id = $1 ORDER BY sort_order
    `, [ad.id]);

    const shots = await db.query(`
      SELECT * FROM ad_shots
      WHERE ad_id = $1 ORDER BY shot_number
    `, [ad.id]);

    results.push(formatAdFromDb(ad, tactics.rows, shots.rows));
  }

  return results;
}

export async function getAdById(id) {
  const db = getPool();
  const result = await db.query(`SELECT * FROM ads WHERE id = $1`, [id]);
  const ad = result.rows[0];
  if (!ad) return null;

  const tactics = await db.query(`
    SELECT name, description FROM ad_tactics
    WHERE ad_id = $1 ORDER BY sort_order
  `, [id]);

  const shots = await db.query(`
    SELECT * FROM ad_shots
    WHERE ad_id = $1 ORDER BY shot_number
  `, [id]);

  return formatAdFromDb(ad, tactics.rows, shots.rows);
}

export async function createAd(ad) {
  const db = getPool();

  // Insert main ad
  await db.query(`
    INSERT INTO ads (id, title, video_src, source, creator, product, vertical, type,
      hook_text_overlay, hook_spoken, full_transcript, why_summary, why_key_lesson,
      tags, date_added)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `, [
    ad.id,
    ad.title,
    ad.videoSrc,
    ad.source,
    ad.creator,
    ad.product,
    ad.vertical,
    ad.type,
    ad.hook?.textOverlay || '',
    ad.hook?.spoken || '',
    ad.fullTranscript,
    ad.whyItWorked?.summary || '',
    ad.whyItWorked?.keyLesson || '',
    JSON.stringify(ad.tags || []),
    ad.dateAdded
  ]);

  // Insert tactics
  if (ad.whyItWorked?.tactics) {
    for (let i = 0; i < ad.whyItWorked.tactics.length; i++) {
      const tactic = ad.whyItWorked.tactics[i];
      await db.query(`
        INSERT INTO ad_tactics (ad_id, name, description, sort_order)
        VALUES ($1, $2, $3, $4)
      `, [ad.id, tactic.name, tactic.description, i]);
    }
  }

  // Insert shots
  if (ad.shots) {
    for (const shot of ad.shots) {
      await db.query(`
        INSERT INTO ad_shots (ad_id, shot_number, start_time, end_time, timestamp,
          type, thumbnail, description, transcript, text_overlay, purpose)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        ad.id,
        shot.id,
        shot.startTime,
        shot.endTime,
        shot.timestamp,
        shot.type || 'video',
        shot.thumbnail,
        shot.description,
        shot.transcript,
        shot.textOverlay,
        shot.purpose
      ]);
    }
  }

  return ad.id;
}

export async function updateAd(id, data) {
  const db = getPool();

  // Build dynamic update query
  const fields = [];
  const values = [];
  let paramIndex = 1;

  if (data.title !== undefined) { fields.push(`title = $${paramIndex++}`); values.push(data.title); }
  if (data.videoSrc !== undefined) { fields.push(`video_src = $${paramIndex++}`); values.push(data.videoSrc); }
  if (data.source !== undefined) { fields.push(`source = $${paramIndex++}`); values.push(data.source); }
  if (data.creator !== undefined) { fields.push(`creator = $${paramIndex++}`); values.push(data.creator); }
  if (data.product !== undefined) { fields.push(`product = $${paramIndex++}`); values.push(data.product); }
  if (data.vertical !== undefined) { fields.push(`vertical = $${paramIndex++}`); values.push(data.vertical); }
  if (data.type !== undefined) { fields.push(`type = $${paramIndex++}`); values.push(data.type); }
  if (data.hook?.textOverlay !== undefined) { fields.push(`hook_text_overlay = $${paramIndex++}`); values.push(data.hook.textOverlay); }
  if (data.hook?.spoken !== undefined) { fields.push(`hook_spoken = $${paramIndex++}`); values.push(data.hook.spoken); }
  if (data.fullTranscript !== undefined) { fields.push(`full_transcript = $${paramIndex++}`); values.push(data.fullTranscript); }
  if (data.tags !== undefined) { fields.push(`tags = $${paramIndex++}`); values.push(JSON.stringify(data.tags)); }

  if (fields.length > 0) {
    values.push(id);
    await db.query(`UPDATE ads SET ${fields.join(', ')} WHERE id = $${paramIndex}`, values);
  }

  return true;
}

export async function deleteAd(id) {
  const db = getPool();
  const result = await db.query(`DELETE FROM ads WHERE id = $1`, [id]);
  return result.rowCount > 0;
}

function formatAdFromDb(ad, tactics, shots) {
  let tags = ad.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (e) { tags = []; }
  }

  return {
    id: ad.id,
    title: ad.title,
    videoSrc: ad.video_src,
    source: ad.source,
    creator: ad.creator,
    product: ad.product,
    vertical: ad.vertical,
    type: ad.type,
    hook: {
      textOverlay: ad.hook_text_overlay,
      spoken: ad.hook_spoken
    },
    fullTranscript: ad.full_transcript,
    whyItWorked: {
      summary: ad.why_summary,
      tactics: tactics.map(t => ({ name: t.name, description: t.description })),
      keyLesson: ad.why_key_lesson
    },
    shots: shots.map(s => ({
      id: s.shot_number,
      startTime: s.start_time,
      endTime: s.end_time,
      timestamp: s.timestamp,
      type: s.type,
      thumbnail: s.thumbnail,
      description: s.description,
      transcript: s.transcript,
      textOverlay: s.text_overlay,
      purpose: s.purpose
    })),
    tags: tags || [],
    dateAdded: ad.date_added
  };
}

// ==================== IMAGES ====================

export async function getAllImages() {
  const db = getPool();
  const images = await db.query(`
    SELECT * FROM images ORDER BY date_added DESC
  `);

  return images.rows.map(formatImageFromDb);
}

export async function getImageById(id) {
  const db = getPool();
  const result = await db.query(`SELECT * FROM images WHERE id = $1`, [id]);
  return result.rows[0] ? formatImageFromDb(result.rows[0]) : null;
}

export async function createImage(image) {
  const db = getPool();
  const dateAdded = image.dateAdded || new Date().toISOString().split('T')[0];

  await db.query(`
    INSERT INTO images (id, title, image_src, source, creator, prompt, raw_prompt, tags, date_added)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [
    image.id,
    image.title || '',
    image.imageSrc || image.url,
    image.source || '',
    image.creator || '',
    typeof image.prompt === 'object' ? JSON.stringify(image.prompt) : (image.prompt || ''),
    image.rawPrompt || '',
    JSON.stringify(image.tags || []),
    dateAdded
  ]);

  return image.id;
}

export async function updateImagePrompt(id, prompt, rawPrompt) {
  const db = getPool();
  const promptStr = typeof prompt === 'object' ? JSON.stringify(prompt) : (prompt || '');
  const result = await db.query(
    `UPDATE images SET prompt = $1, raw_prompt = $2 WHERE id = $3`,
    [promptStr, rawPrompt || '', id]
  );
  return result.rowCount > 0;
}

export async function deleteImage(id) {
  const db = getPool();
  const result = await db.query(`DELETE FROM images WHERE id = $1`, [id]);
  return result.rowCount > 0;
}

function formatImageFromDb(img) {
  let prompt = img.prompt;
  if (typeof prompt === 'string') {
    try { prompt = JSON.parse(prompt); } catch (e) { /* keep as string */ }
  }

  let tags = img.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (e) { tags = []; }
  }

  return {
    id: img.id,
    title: img.title,
    imageSrc: img.image_src,
    source: img.source,
    creator: img.creator,
    prompt: prompt,
    rawPrompt: img.raw_prompt,
    tags: tags || [],
    dateAdded: img.date_added
  };
}

// ==================== TWEETS ====================

export async function getAllTweets() {
  const db = getPool();
  const tweets = await db.query(`
    SELECT * FROM tweets ORDER BY added_at DESC
  `);

  return tweets.rows.map(formatTweetFromDb);
}

export async function createTweet(tweet) {
  const db = getPool();
  const addedAt = tweet.addedAt || new Date().toISOString();

  await db.query(`
    INSERT INTO tweets (id, url, tags, added_at)
    VALUES ($1, $2, $3, $4)
  `, [
    tweet.id,
    tweet.url,
    JSON.stringify(tweet.tags || []),
    addedAt
  ]);

  return tweet.id;
}

export async function deleteTweet(id) {
  const db = getPool();
  const result = await db.query(`DELETE FROM tweets WHERE id = $1`, [id]);
  return result.rowCount > 0;
}

export async function updateTweet(id, data) {
  const db = getPool();
  if (data.tags !== undefined) {
    await db.query(
      `UPDATE tweets SET tags = $1 WHERE id = $2`,
      [JSON.stringify(data.tags), id]
    );
  }
  return true;
}

function formatTweetFromDb(tweet) {
  let tags = tweet.tags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch (e) { tags = []; }
  }

  return {
    id: tweet.id,
    url: tweet.url,
    tags: tags || [],
    addedAt: tweet.added_at
  };
}
