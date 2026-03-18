// Ad Vault Cloudflare Worker - Main Entry Point
// Handles all API routes for Ad Vault, Image Vault, and Tweet Vault

import * as db from './database.js';
import * as storage from './storage.js';
import { processAd, extractTweetId } from './adProcessor.js';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// JSON response helper
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// Error response helper
function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// Main fetch handler
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ==================== STORAGE ROUTES ====================
      // Serve files from R2
      if (path.startsWith('/storage/')) {
        const key = path.replace('/storage/', '');
        const file = await storage.getFromR2(env.STORAGE, key);

        if (!file) {
          return errorResponse('File not found', 404);
        }

        return new Response(file.data, {
          headers: {
            'Content-Type': file.contentType,
            'Cache-Control': 'public, max-age=31536000',
            ...corsHeaders
          }
        });
      }

      // ==================== ADS API ====================
      if (path === '/api/ads' && request.method === 'GET') {
        const ads = await db.getAllAds(env.DB);
        return jsonResponse(ads);
      }

      if (path === '/api/ads' && request.method === 'POST') {
        const data = await request.json();
        const id = await db.createAd(env.DB, data);
        return jsonResponse({ success: true, id });
      }

      if (path.match(/^\/api\/ads\/[^\/]+$/) && request.method === 'GET') {
        const id = path.split('/').pop();
        const ad = await db.getAdById(env.DB, id);
        if (!ad) return errorResponse('Ad not found', 404);
        return jsonResponse(ad);
      }

      if (path === '/api/delete-ad' && request.method === 'POST') {
        const { id, deleteFile = true } = await request.json();
        if (!id) return errorResponse('Ad ID is required');

        // Get ad to find video path before deleting
        const ad = await db.getAdById(env.DB, id);
        if (!ad) return errorResponse('Ad not found', 404);

        // Delete from database
        const deleted = await db.deleteAd(env.DB, id);
        if (!deleted) return errorResponse('Failed to delete ad');

        // Delete video from R2 if requested
        if (deleteFile && ad.videoSrc) {
          const key = ad.videoSrc.replace('/storage/', '');
          try {
            await storage.deleteFromR2(env.STORAGE, key);
          } catch (e) {
            console.error('Failed to delete video:', e);
          }
        }

        return jsonResponse({ success: true, message: 'Ad deleted' });
      }

      // Process ad from X.com URL
      if (path === '/api/process-ad' && request.method === 'POST') {
        const { url: adUrl } = await request.json();
        if (!adUrl) return errorResponse('URL is required');

        const tweetId = extractTweetId(adUrl);
        if (!tweetId) return errorResponse('Invalid Twitter/X URL');

        // Check if already exists
        const existing = await db.getAdById(env.DB, tweetId);
        if (existing) return errorResponse('Ad already exists', 409);

        // Process the ad
        const ad = await processAd(env, adUrl);

        // Save to database
        await db.createAd(env.DB, ad);

        return jsonResponse({
          success: true,
          id: ad.id,
          title: ad.title,
          creator: ad.creator,
          transcript_length: ad.fullTranscript?.length || 0,
          shots_count: ad.shots?.length || 0
        });
      }

      // ==================== IMAGES API ====================
      if (path === '/api/images' && request.method === 'GET') {
        const images = await db.getAllImages(env.DB);
        return jsonResponse(images);
      }

      if (path === '/api/add-image-entry' && request.method === 'POST') {
        const data = await request.json();
        const id = await db.createImage(env.DB, data);
        return jsonResponse({ success: true, id });
      }

      if (path === '/api/backfill-prompts' && request.method === 'POST') {
        const { images } = await request.json();
        if (!Array.isArray(images)) return errorResponse('images array is required');
        let updated = 0;
        for (const img of images) {
          const success = await db.updateImagePrompt(env.DB, img.id, img.prompt, img.rawPrompt);
          if (success) updated++;
        }
        return jsonResponse({ success: true, updated, total: images.length });
      }

      if (path === '/api/delete-image' && request.method === 'POST') {
        const { id, deleteFile = true } = await request.json();
        if (!id) return errorResponse('Image ID is required');

        // Get image to find path before deleting
        const images = await db.getAllImages(env.DB);
        const image = images.find(i => i.id === id);
        if (!image) return errorResponse('Image not found', 404);

        // Delete from database
        const deleted = await db.deleteImage(env.DB, id);
        if (!deleted) return errorResponse('Failed to delete image');

        // Delete from R2 if requested
        if (deleteFile && image.imageSrc) {
          const key = image.imageSrc.replace('/storage/', '');
          try {
            await storage.deleteFromR2(env.STORAGE, key);
          } catch (e) {
            console.error('Failed to delete image file:', e);
          }
        }

        return jsonResponse({ success: true, message: 'Image deleted' });
      }

      // Download and store image
      if (path === '/api/download-image' && request.method === 'POST') {
        const { url: imageUrl, filename } = await request.json();
        if (!imageUrl) return errorResponse('URL is required');

        const key = `images/vault/${filename || `image-${Date.now()}.jpg`}`;
        const result = await storage.downloadAndStoreToR2(env.STORAGE, imageUrl, key);

        return jsonResponse({
          success: true,
          path: `/storage/${key}`,
          size: result.size
        });
      }

      // ==================== TWEETS API ====================
      if (path === '/api/tweets' && request.method === 'GET') {
        const tweets = await db.getAllTweets(env.DB);
        return jsonResponse(tweets);
      }

      if (path === '/api/add-tweet' && request.method === 'POST') {
        const data = await request.json();
        const tweetId = extractTweetId(data.url);
        if (!tweetId) return errorResponse('Invalid Twitter/X URL');

        const tweet = {
          id: `tweet-${tweetId}`,
          url: data.url,
          tags: data.tags || [],
          addedAt: new Date().toISOString().split('T')[0]
        };

        await db.createTweet(env.DB, tweet);
        return jsonResponse({ success: true, id: tweet.id });
      }

      if (path === '/api/add-tweets-batch' && request.method === 'POST') {
        const { urls, tags } = await request.json();
        if (!urls?.length) return errorResponse('URLs array is required');
        if (!tags?.length) return errorResponse('At least one tag is required');

        const results = [];
        const today = new Date().toISOString().split('T')[0];

        for (const url of urls) {
          const tweetId = extractTweetId(url);
          if (!tweetId) {
            results.push({ url, success: false, error: 'Invalid URL' });
            continue;
          }

          const tweet = {
            id: `tweet-${tweetId}`,
            url,
            tags,
            addedAt: today
          };

          try {
            await db.createTweet(env.DB, tweet);
            results.push({ url, success: true, id: tweet.id });
          } catch (e) {
            results.push({ url, success: false, error: e.message });
          }
        }

        return jsonResponse({
          success: true,
          results,
          added: results.filter(r => r.success).length,
          total: urls.length
        });
      }

      if (path === '/api/delete-tweet' && request.method === 'POST') {
        const { id } = await request.json();
        if (!id) return errorResponse('Tweet ID is required');

        const deleted = await db.deleteTweet(env.DB, id);
        if (!deleted) return errorResponse('Tweet not found', 404);

        return jsonResponse({ success: true, message: 'Tweet deleted' });
      }

      // ==================== FETCH TWEET DATA ====================
      if (path === '/api/fetch-tweet' && request.method === 'POST') {
        const { url: tweetUrl } = await request.json();
        if (!tweetUrl) return errorResponse('URL is required');

        const tweetId = extractTweetId(tweetUrl);
        const username = tweetUrl.match(/(?:twitter|x)\.com\/([^\/]+)\/status/)?.[1];

        if (!tweetId || !username) {
          return errorResponse('Invalid Twitter/X URL');
        }

        // Fetch from FXTwitter
        const fxUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;
        const response = await fetch(fxUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!response.ok) {
          return errorResponse('Failed to fetch tweet data');
        }

        const data = await response.json();
        if (data.code !== 200) {
          return errorResponse(data.message || 'Tweet not found');
        }

        const tweet = data.tweet;

        // Extract images
        const images = [];
        if (tweet.media?.photos) {
          for (const photo of tweet.media.photos) {
            if (photo.url) images.push(photo.url);
          }
        }

        return jsonResponse({
          id: tweetId,
          text: tweet.text,
          images,
          author: tweet.author?.screen_name,
          authorName: tweet.author?.name
        });
      }

      // ==================== HEALTH CHECK ====================
      if (path === '/api/health' && request.method === 'GET') {
        return jsonResponse({ status: 'ok', version: '2.0-cloudflare' });
      }

      // ==================== 404 ====================
      return errorResponse('Not found', 404);

    } catch (error) {
      console.error('Worker error:', error);
      return errorResponse(error.message || 'Internal server error', 500);
    }
  }
};
