// Ad Vault Express Server - Railway deployment
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from './lib/database.js';
import * as storage from './lib/storage.js';
import { extractTweetId, processAd } from './lib/adProcessor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from React build
app.use(express.static(path.join(__dirname, 'app/dist')));

// Serve uploaded files from storage directory
app.use('/storage', express.static(path.join(__dirname, 'storage')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0-railway' });
});

// ==================== ADS ====================

// GET /api/ads
app.get('/api/ads', async (req, res) => {
  try {
    const ads = await db.getAllAds();
    res.json(ads);
  } catch (error) {
    console.error('Error fetching ads:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/ads
app.post('/api/ads', async (req, res) => {
  try {
    const id = await db.createAd(req.body);
    res.json({ success: true, id });
  } catch (error) {
    console.error('Error creating ad:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ads/:id
app.get('/api/ads/:id', async (req, res) => {
  try {
    const ad = await db.getAdById(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    res.json(ad);
  } catch (error) {
    console.error('Error fetching ad:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/ads/:id
app.put('/api/ads/:id', async (req, res) => {
  try {
    await db.updateAd(req.params.id, req.body);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating ad:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/delete-ad
app.post('/api/delete-ad', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });
    await db.deleteAd(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting ad:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/process-ad
app.post('/api/process-ad', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const result = await processAd(url);
    res.json(result);
  } catch (error) {
    console.error('Error processing ad:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== IMAGES ====================

// GET /api/images
app.get('/api/images', async (req, res) => {
  try {
    const images = await db.getAllImages();
    res.json(images);
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/images (multipart form)
app.post('/api/images', express.raw({ type: 'multipart/form-data', limit: '50mb' }), async (req, res) => {
  // Note: For file uploads, we'll need multer. For now, use add-image-entry
  res.status(501).json({ error: 'Use /api/add-image-entry or /api/download-image instead' });
});

// POST /api/add-image-entry
app.post('/api/add-image-entry', async (req, res) => {
  try {
    const { id, title, imageSrc, url, source, creator, prompt, rawPrompt, tags, dateAdded } = req.body;
    if (!imageSrc && !url) return res.status(400).json({ error: 'URL or imageSrc is required' });
    const imageId = id || crypto.randomUUID();
    await db.createImage({
      id: imageId,
      title: title || '',
      imageSrc: imageSrc || url,
      source: source || '',
      creator: creator || '',
      prompt: prompt || '',
      rawPrompt: rawPrompt || '',
      tags: tags || [],
      dateAdded: dateAdded || new Date().toISOString().split('T')[0]
    });
    res.json({ success: true, id: imageId });
  } catch (error) {
    console.error('Error adding image entry:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/backfill-prompts
app.post('/api/backfill-prompts', async (req, res) => {
  try {
    const { images } = req.body;
    if (!Array.isArray(images)) return res.status(400).json({ error: 'images array is required' });
    let updated = 0;
    for (const img of images) {
      const success = await db.updateImagePrompt(img.id, img.prompt, img.rawPrompt);
      if (success) updated++;
    }
    res.json({ success: true, updated, total: images.length });
  } catch (error) {
    console.error('Error backfilling prompts:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/delete-image
app.post('/api/delete-image', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });
    const image = await db.getImageById(id);
    if (image?.url?.startsWith('/storage/')) {
      const key = image.url.replace('/storage/', '');
      await storage.deleteFile(key);
    }
    await db.deleteImage(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/download-image
app.post('/api/download-image', async (req, res) => {
  try {
    const { url, tags, source } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    const response = await fetch(url);
    if (!response.ok) return res.status(500).json({ error: 'Failed to download image' });

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : contentType.includes('gif') ? 'gif' : contentType.includes('webp') ? 'webp' : 'jpg';
    const id = crypto.randomUUID();
    const key = `images/${id}.${ext}`;

    const buffer = Buffer.from(await response.arrayBuffer());
    await storage.saveFile(key, buffer, contentType);
    await db.createImage({ id, url: `/storage/${key}`, tags: tags || [], source: source || url });

    res.json({ success: true, id, url: `/storage/${key}` });
  } catch (error) {
    console.error('Error downloading image:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TWEETS ====================

// GET /api/tweets
app.get('/api/tweets', async (req, res) => {
  try {
    const tweets = await db.getAllTweets();
    res.json(tweets);
  } catch (error) {
    console.error('Error fetching tweets:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/add-tweet
app.post('/api/add-tweet', async (req, res) => {
  try {
    const data = req.body;
    if (!data.url) return res.status(400).json({ error: 'URL is required' });
    const id = crypto.randomUUID();
    await db.createTweet({ id, ...data });
    res.json({ success: true, id });
  } catch (error) {
    console.error('Error adding tweet:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/add-tweets-batch
app.post('/api/add-tweets-batch', async (req, res) => {
  try {
    const { urls, tags } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'URLs array is required' });
    }
    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ error: 'At least one tag is required' });
    }

    const results = [];
    const addedAt = new Date().toISOString();

    for (const url of urls) {
      const id = crypto.randomUUID();
      await db.createTweet({ id, url, tags, addedAt });
      results.push({ id, url });
    }

    res.json({ success: true, added: results.length, total: urls.length, results });
  } catch (error) {
    console.error('Error adding tweets batch:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/delete-tweet
app.post('/api/delete-tweet', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });
    await db.deleteTweet(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting tweet:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/update-tweet
app.post('/api/update-tweet', async (req, res) => {
  try {
    const { id, tags } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });
    await db.updateTweet(id, { tags });
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating tweet:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/fetch-tweet
app.post('/api/fetch-tweet', async (req, res) => {
  try {
    const { url: tweetUrl } = req.body;
    if (!tweetUrl) return res.status(400).json({ error: 'URL is required' });

    const tweetId = extractTweetId(tweetUrl);
    const username = tweetUrl.match(/(?:twitter|x)\.com\/([^\/]+)\/status/)?.[1];
    if (!tweetId || !username) return res.status(400).json({ error: 'Invalid Twitter/X URL' });

    const fxUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;
    const response = await fetch(fxUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return res.status(500).json({ error: 'Failed to fetch tweet data' });

    const data = await response.json();
    if (data.code !== 200) return res.status(404).json({ error: data.message || 'Tweet not found' });

    const tweet = data.tweet;
    const images = [];
    if (tweet.media?.photos) {
      for (const photo of tweet.media.photos) {
        if (photo.url) images.push(photo.url);
      }
    }

    res.json({
      id: tweetId,
      text: tweet.text,
      images,
      author: tweet.author?.screen_name,
      authorName: tweet.author?.name
    });
  } catch (error) {
    console.error('Error fetching tweet:', error);
    res.status(500).json({ error: error.message });
  }
});

// Catch-all for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'app/dist/index.html'));
});

// Initialize database and start server
async function start() {
  try {
    await db.initDatabase();
    console.log('Database initialized');

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
