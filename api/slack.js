const { App } = require('@slack/bolt');
const winston = require('winston');
require('dotenv').config();

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// In-memory storage
class RatingStore {
  constructor() {
    this.ratings = new Map();
    this.rateLimit = new Map();
  }

  createRating(requesterId, channelId) {
    const id = Date.now().toString();
    const rating = {
      id,
      requesterId,
      channelId,
      status: 'pending',
      createdAt: new Date()
    };
    this.ratings.set(id, rating);
    return rating;
  }

  getRating(id) {
    return this.ratings.get(id);
  }

  updateRating(id, reviewerId, rating) {
    const existing = this.ratings.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      reviewerId,
      rating,
      status: 'completed'
    };
    this.ratings.set(id, updated);
    return updated;
  }

  checkRateLimit(userId) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const userRequests = this.rateLimit.get(userId) || [];
    const recentRequests = userRequests.filter(time => now - time < windowMs);
    this.rateLimit.set(userId, recentRequests);
    return recentRequests.length >= 5;
  }

  addRateLimitEntry(userId) {
    const userRequests = this.rateLimit.get(userId) || [];
    userRequests.push(Date.now());
    this.rateLimit.set(userId, userRequests);
  }
}

const store = new RatingStore();

// Initialize Slack app
const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  token: process.env.SLACK_BOT_TOKEN,
});

// Handle /rate command
app.command('/rate', async ({ command, ack, say, client }) => {
  try {
    await ack();
    
    if (store.checkRateLimit(command.user_id)) {
      throw new Error('Rate limit exceeded. Please try again later.');
    }
    
    store.addRateLimitEntry(command.user_id);
    const rating = store.createRating(command.user_id, command.channel_id);
    
    logger.info(`New rating request created by ${command.user_id}`);
    
    await say({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<@${command.user_id}> has requested a rating!`
          }
        },
        {
          type: "actions",
          block_id: `rating_${rating.id}`,
          elements: [
            {
              type: "radio_buttons",
              action_id: "star_rating",
              options: [
                { text: { type: "plain_text", text: "⭐" }, value: "1" },
                { text: { type: "plain_text", text: "⭐⭐" }, value: "2" },
                { text: { type: "plain_text", text: "⭐⭐⭐" }, value: "3" },
                { text: { type: "plain_text", text: "⭐⭐⭐⭐" }, value: "4" },
                { text: { type: "plain_text", text: "⭐⭐⭐⭐⭐" }, value: "5" }
              ]
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Submit Rating" },
              action_id: "submit_rating",
              style: "primary"
            }
          ]
        }
      ]
    });
  } catch (error) {
    logger.error('Error handling rate command:', error);
    await say({
      text: `Error: ${error.message}`
    });
  }
});

// Handle rating submission
app.action('submit_rating', async ({ body, ack, say, client }) => {
  try {
    await ack();
    
    const ratingId = body.actions[0].block_id.split('_')[1];
    const reviewerId = body.user.id;
    
    const rating = store.getRating(ratingId);
    if (!rating) {
      throw new Error('Rating request not found');
    }
    
    if (rating.requesterId === reviewerId) {
      throw new Error('You cannot rate yourself');
    }
    
    const selectedRating = body.state.values[`rating_${ratingId}`].star_rating.selected_option.value;
    store.updateRating(ratingId, reviewerId, parseInt(selectedRating));
    
    logger.info(`Rating completed: ${reviewerId} rated ${rating.requesterId} with ${selectedRating} stars`);
    
    await client.chat.postMessage({
      channel: rating.channelId,
      text: `<@${reviewerId}> rated <@${rating.requesterId}> ${selectedRating} ⭐`,
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Rating submitted on <!date^${Math.floor(Date.now()/1000)}^{date_short_pretty} at {time}|${new Date().toLocaleString()}>`
            }
          ]
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<@${reviewerId}> rated <@${rating.requesterId}> ${selectedRating} ${'⭐'.repeat(parseInt(selectedRating))}`
          }
        }
      ]
    });
    
    try {
      await client.chat.delete({
        channel: rating.channelId,
        ts: body.message.ts
      });
    } catch (error) {
      logger.error('Error deleting message:', error);
    }
    
  } catch (error) {
    logger.error('Error submitting rating:', error);
    await say({
      text: `Error: ${error.message}`
    });
  }
});

// Handler for Vercel serverless function
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    // Handle Slack events and interactions
    const payload = req.body;
    
    try {
      // Handle different types of requests
      if (payload.type === 'url_verification') {
        // Handle Slack URL verification
        return res.json({ challenge: payload.challenge });
      }
      
      // Process the request through the Bolt app
      await app.processEvent(payload);
      return res.status(200).end();
    } catch (error) {
      logger.error('Error processing request:', error);
      return res.status(500).json({ error: 'Failed to process request' });
    }
  } else {
    // Health check endpoint
    res.status(200).json({ status: 'ok' });
  }
};
