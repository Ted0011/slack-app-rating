// Import required dependencies
const { App, ExpressReceiver } = require('@slack/bolt');
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

  // Create new rating request
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

  // Get rating by ID
  getRating(id) {
    return this.ratings.get(id);
  }

  // Update rating
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

  // Check rate limit
  checkRateLimit(userId) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const userRequests = this.rateLimit.get(userId) || [];
    
    // Clean up old requests
    const recentRequests = userRequests.filter(time => now - time < windowMs);
    this.rateLimit.set(userId, recentRequests);

    return recentRequests.length >= 5;
  }

  // Add rate limit entry
  addRateLimitEntry(userId) {
    const userRequests = this.rateLimit.get(userId) || [];
    userRequests.push(Date.now());
    this.rateLimit.set(userId, userRequests);
  }
}

const store = new RatingStore();

// Initialize Express receiver
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Add a route for checking health
receiver.router.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Rest of the code remains the same...
// Handle /rate command
app.command('/rate', async ({ command, ack, say, client }) => {
  try {
    await ack();
    
    // Authenticate user
    const user = await authenticateUser({ command, client });
    
    // Check rate limit
    if (store.checkRateLimit(command.user_id)) {
      throw new Error('Rate limit exceeded. Please try again later.');
    }
    
    // Add rate limit entry
    store.addRateLimitEntry(command.user_id);
    
    // Create new rating
    const rating = store.createRating(command.user_id, command.channel_id);
    
    logger.info(`New rating request created by ${command.user_id}`);
    
    // Create interactive message with stars
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
                {
                  text: { type: "plain_text", text: "⭐" },
                  value: "1"
                },
                {
                  text: { type: "plain_text", text: "⭐⭐" },
                  value: "2"
                },
                {
                  text: { type: "plain_text", text: "⭐⭐⭐" },
                  value: "3"
                },
                {
                  text: { type: "plain_text", text: "⭐⭐⭐⭐" },
                  value: "4"
                },
                {
                  text: { type: "plain_text", text: "⭐⭐⭐⭐⭐" },
                  value: "5"
                }
              ]
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Submit Rating"
              },
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
      text: `Sorry, there was an error processing your request: ${error.message}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:x: Error: ${error.message}`
          }
        }
      ]
    });
  }
});

// Handle rating submission
app.action('submit_rating', async ({ body, ack, say, client }) => {
  try {
    await ack();
    
    const ratingId = body.actions[0].block_id.split('_')[1];
    const reviewerId = body.user.id;
    
    // Fetch rating
    const rating = store.getRating(ratingId);
    if (!rating) {
      throw new Error('Rating request not found');
    }
    
    // Prevent self-rating
    if (rating.requesterId === reviewerId) {
      throw new Error('You cannot rate yourself');
    }
    
    // Get selected rating
    const selectedRating = body.state.values[`rating_${ratingId}`].star_rating.selected_option.value;
    
    // Update rating
    store.updateRating(ratingId, reviewerId, parseInt(selectedRating));
    
    logger.info(`Rating completed: ${reviewerId} rated ${rating.requesterId} with ${selectedRating} stars`);
    
    // Post immutable rating message
    const result = await client.chat.postMessage({
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
    
    // Delete original rating request message
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
      text: `Sorry, there was an error submitting your rating: ${error.message}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:x: Error: ${error.message}`
          }
        }
      ]
    });
  }
});
// Start the app
(async () => {
  try {
    const port = process.env.PORT || 3000;
    await app.start(port);
    logger.info(`⚡️ Bolt app is running on port ${port}!`);
  } catch (error) {
    logger.error('Error starting app:', error);
    process.exit(1);
  }
})();
