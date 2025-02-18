const { createServer } = require('http');
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

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: false,
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
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

`async function verifyChannelAccess(client, channelId) {
  try {
    // Try to get channel info to verify access
    await client.conversations.info({
      channel: channelId
    });
    return true;
  } catch (error) {
    if (error.data?.error === 'channel_not_found') {
      return false;
    }
    throw error; // Rethrow other errors
  }
}`
app.command('/rate', async ({ command, ack, respond, client }) => {
  try {
    await ack(); // Acknowledge immediately

    if (store.checkRateLimit(command.user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ Rate limit exceeded. Please try again later.'
      });
      return;
    }

    store.addRateLimitEntry(command.user_id);
    const rating = store.createRating(command.user_id, command.channel_id);

    logger.info(`New rating request created by ${command.user_id} in channel ${command.channel_id}`);

    await respond({
      response_type: 'in_channel',
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
    await respond({
      response_type: 'ephemeral',
      text: `Sorry, something went wrong. ${error.message}`
    });
  }
});
// Handle rating submission with immediate acknowledgment
//
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const payload = req.body;

      // Log the incoming payload for debugging
      logger.info('Incoming payload:', { payload });

      if (payload.type === 'url_verification') {
        return res.json({ challenge: payload.challenge });
      }

      // Parse the nested payload if it exists
      if (payload.payload) {
        const parsedPayload = JSON.parse(payload.payload);
        req.body = parsedPayload; // Replace the body with the parsed payload
      }

      // Handle the request through the receiver
      await receiver.requestHandler(req, res);
    } catch (error) {
      logger.error('Error processing request:', error);
      return res.status(500).json({ error: 'Failed to process request' });
    }
  } else if (req.method === 'GET') {
    res.status(200).json({ status: 'ok' });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};

app.action(/^(star_rating|submit_rating)$/, async ({ action, body, ack, respond, client }) => {
  await ack(); // Acknowledge immediately

  try {
    // Handle the action
    if (action.action_id === 'star_rating') {
      return; // Do nothing for star rating selection
    }

    // Handle submit_rating action
    const ratingId = body.actions[0].block_id.split('_')[1];
    const reviewerId = body.user.id;

    const rating = store.getRating(ratingId);
    if (!rating) {
      throw new Error('Rating request not found');
    }

    if (rating.requesterId === reviewerId) {
      throw new Error('You cannot rate yourself');
    }

    const selectedRating = body.state.values[`rating_${ratingId}`]?.star_rating?.selected_option?.value;
    if (!selectedRating) {
      throw new Error('Please select a rating before submitting');
    }

    store.updateRating(ratingId, reviewerId, parseInt(selectedRating));

    logger.info(`Rating completed: ${reviewerId} rated ${rating.requesterId} with ${selectedRating} stars`);

    // Post the final rating message in the channel
    await client.chat.postMessage({
      channel: rating.channelId,
      text: `<@${reviewerId}> rated <@${rating.requesterId}> ${selectedRating} ⭐`,
      blocks: [
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Rating submitted on <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} at {time}|${new Date().toLocaleString()}>`
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

    // Delete the original message
    try {
      await client.chat.delete({
        channel: rating.channelId,
        ts: body.message.ts
      });
    } catch (error) {
      logger.error('Error deleting message:', error);
    }

    // Send a DM to the requester notifying them about the rating
    try {
      await client.chat.postMessage({
        channel: rating.requesterId,  // This sends a DM to the requester
        text: `Your rating request has been completed! <@${reviewerId}> rated you ${selectedRating} ⭐.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `You have received a rating from <@${reviewerId}>: ${selectedRating} ⭐`
            }
          }
        ]
      });
    } catch (error) {
      logger.error('Error sending DM to requester:', error);
    }
    
  } catch (error) {
    logger.error('Error processing action:', error);
    await respond({
      response_type: 'ephemeral',
      text: `Error: ${error.message}`
    });
  }
});
