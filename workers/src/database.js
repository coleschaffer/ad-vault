// D1 Database utilities for Ad Vault

// ==================== ADS ====================

export async function getAllAds(db) {
  const ads = await db.prepare(`
    SELECT * FROM ads ORDER BY date_added DESC
  `).all();

  // Fetch related data for each ad
  const results = [];
  for (const ad of ads.results) {
    const tactics = await db.prepare(`
      SELECT name, description FROM ad_tactics
      WHERE ad_id = ? ORDER BY sort_order
    `).bind(ad.id).all();

    const shots = await db.prepare(`
      SELECT * FROM ad_shots
      WHERE ad_id = ? ORDER BY shot_number
    `).bind(ad.id).all();

    results.push(formatAdFromDb(ad, tactics.results, shots.results));
  }

  return results;
}

export async function getAdById(db, id) {
  const ad = await db.prepare(`SELECT * FROM ads WHERE id = ?`).bind(id).first();
  if (!ad) return null;

  const tactics = await db.prepare(`
    SELECT name, description FROM ad_tactics
    WHERE ad_id = ? ORDER BY sort_order
  `).bind(id).all();

  const shots = await db.prepare(`
    SELECT * FROM ad_shots
    WHERE ad_id = ? ORDER BY shot_number
  `).bind(id).all();

  return formatAdFromDb(ad, tactics.results, shots.results);
}

export async function createAd(db, ad) {
  // Insert main ad
  await db.prepare(`
    INSERT INTO ads (id, title, video_src, source, creator, product, vertical, type,
      hook_text_overlay, hook_spoken, full_transcript, why_summary, why_key_lesson,
      tags, date_added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
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
  ).run();

  // Insert tactics
  if (ad.whyItWorked?.tactics) {
    for (let i = 0; i < ad.whyItWorked.tactics.length; i++) {
      const tactic = ad.whyItWorked.tactics[i];
      await db.prepare(`
        INSERT INTO ad_tactics (ad_id, name, description, sort_order)
        VALUES (?, ?, ?, ?)
      `).bind(ad.id, tactic.name, tactic.description, i).run();
    }
  }

  // Insert shots
  if (ad.shots) {
    for (const shot of ad.shots) {
      await db.prepare(`
        INSERT INTO ad_shots (ad_id, shot_number, start_time, end_time, timestamp,
          type, thumbnail, description, transcript, text_overlay, purpose)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
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
      ).run();
    }
  }

  return ad.id;
}

export async function deleteAd(db, id) {
  // Cascading delete handles tactics and shots
  const result = await db.prepare(`DELETE FROM ads WHERE id = ?`).bind(id).run();
  return result.changes > 0;
}

function formatAdFromDb(ad, tactics, shots) {
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
    tags: JSON.parse(ad.tags || '[]'),
    dateAdded: ad.date_added
  };
}

// ==================== IMAGES ====================

export async function getAllImages(db) {
  const images = await db.prepare(`
    SELECT * FROM images ORDER BY date_added DESC
  `).all();

  return images.results.map(formatImageFromDb);
}

export async function createImage(db, image) {
  await db.prepare(`
    INSERT INTO images (id, title, image_src, source, creator, prompt, raw_prompt, tags, date_added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    image.id,
    image.title,
    image.imageSrc,
    image.source,
    image.creator,
    typeof image.prompt === 'object' ? JSON.stringify(image.prompt) : image.prompt,
    image.rawPrompt,
    JSON.stringify(image.tags || []),
    image.dateAdded
  ).run();

  return image.id;
}

export async function updateImagePrompt(db, id, prompt, rawPrompt) {
  const result = await db.prepare(`
    UPDATE images SET prompt = ?, raw_prompt = ? WHERE id = ?
  `).bind(
    typeof prompt === 'object' ? JSON.stringify(prompt) : (prompt || ''),
    rawPrompt || '',
    id
  ).run();
  return result.changes > 0;
}

export async function deleteImage(db, id) {
  const result = await db.prepare(`DELETE FROM images WHERE id = ?`).bind(id).run();
  return result.changes > 0;
}

function formatImageFromDb(img) {
  let prompt = img.prompt;
  try {
    prompt = JSON.parse(img.prompt);
  } catch (e) {
    // Keep as string if not valid JSON
  }

  return {
    id: img.id,
    title: img.title,
    imageSrc: img.image_src,
    source: img.source,
    creator: img.creator,
    prompt: prompt,
    rawPrompt: img.raw_prompt,
    tags: JSON.parse(img.tags || '[]'),
    dateAdded: img.date_added
  };
}

// ==================== TWEETS ====================

export async function getAllTweets(db) {
  const tweets = await db.prepare(`
    SELECT * FROM tweets ORDER BY added_at DESC
  `).all();

  return tweets.results.map(formatTweetFromDb);
}

export async function createTweet(db, tweet) {
  await db.prepare(`
    INSERT INTO tweets (id, url, tags, added_at)
    VALUES (?, ?, ?, ?)
  `).bind(
    tweet.id,
    tweet.url,
    JSON.stringify(tweet.tags || []),
    tweet.addedAt
  ).run();

  return tweet.id;
}

export async function deleteTweet(db, id) {
  const result = await db.prepare(`DELETE FROM tweets WHERE id = ?`).bind(id).run();
  return result.changes > 0;
}

function formatTweetFromDb(tweet) {
  return {
    id: tweet.id,
    url: tweet.url,
    tags: JSON.parse(tweet.tags || '[]'),
    addedAt: tweet.added_at
  };
}
