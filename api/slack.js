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
  processBeforeResponse: true, // Changed to true for faster processing
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

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  processBeforeResponse: true
});

async function verifyChannelAccess(client, channelId) {
  try {
    await client.conversations.info({
      channel: channelId
    });
    return true;
  } catch (error) {
    if (error.data?.error === 'channel_not_found') {
      return false;
    }
    throw error;
  }
}

async function postRatingMessage(client, channelId, requesterId, rating) {
  try {
    // First verify channel access
    const canAccess = await verifyChannelAccess(client, channelId);
    if (!canAccess) {
      logger.error(`Bot lacks access to channel ${channelId}`);
      throw new Error('Bot lacks channel access');
    }

    logger.info(`Attempting to post message in channel ${channelId}`);
    
    const result = await client.chat.postMessage({
      channel: channelId,
      text: `${requesterId} has requested a rating!`,
      blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<@${requesterId}> has requested a rating!`
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
    ],
    unfurl_links: false,
    unfurl_media: false
    });

    logger.info(`Successfully posted message in channel ${channelId}`);
    return result;
  } catch (error) {
    logger.error(`Failed to post message in channel ${channelId}:`, error);
    throw error;
  }
}

// Optimized rate command handler
app.command('/rate', async ({ command, ack, respond, client }) => {
  await ack();

  try {
    // Rate limit check...
    if (store.checkRateLimit(command.user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ Rate limit exceeded. Please try again later.'
      });
      return;
    }

    let channelId = command.channel_id;
    
    if (command.channel_name === 'directmessage') {
      try {
        logger.info(`Opening DM with user ${command.user_id}`);
        const dmResponse = await client.conversations.open({
          users: command.user_id
        });
        if (dmResponse.channel && dmResponse.channel.id) {
          channelId = dmResponse.channel.id;
          logger.info(`Successfully opened DM channel ${channelId}`);
        } else {
          throw new Error('Failed to get DM channel ID');
        }
      } catch (dmError) {
        logger.error('Error opening DM:', dmError);
        throw new Error(`Unable to create rating in DM: ${dmError.message}`);
      }
    } else {
      // For non-DM channels, verify access first
      const canAccess = await verifyChannelAccess(client, channelId);
      if (!canAccess) {
        throw new Error(`Bot needs to be invited to the channel first`);
      }
    }

    store.addRateLimitEntry(command.user_id);
    const rating = store.createRating(command.user_id, channelId);

    await postRatingMessage(client, channelId, command.user_id, rating);

  } catch (error) {
    logger.error('Error handling rate command:', error);
    let errorMessage = 'Sorry, something went wrong. ';
    
    if (error.message.includes('needs to be invited')) {
      errorMessage += 'Please invite the bot to this channel first using /invite @rating-bot';
    } else if (error.message.includes('DM')) {
      errorMessage += 'Unable to send direct message. Please try again or contact support.';
    } else {
      errorMessage += error.message;
    }

    await respond({
      response_type: 'ephemeral',
      text: errorMessage
    });
  }
});

app.action(/^(star_rating|submit_rating)$/, async ({ action, body, ack, respond, client }) => {
  await ack();

  try {
    if (action.action_id === 'star_rating') {
      return;
    }

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

    // Post the final rating message
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
  } catch (error) {
    logger.error('Error processing action:', error);
    await respond({
      response_type: 'ephemeral',
      text: `Error: ${error.message}`
    });
  }
});

// Optimized request handler
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      // Handle URL verification immediately
      if (req.body && req.body.type === 'url_verification') {
        return res.json({ challenge: req.body.challenge });
      }

      // Parse payload if needed
      if (req.body && req.body.payload) {
        try {
          const parsedPayload = JSON.parse(req.body.payload);
          req.body = parsedPayload;
        } catch (parseError) {
          logger.error('Error parsing payload:', parseError);
        }
      }

      // Set a shorter timeout for the response
      res.setTimeout(3000, () => {
        if (!res.headersSent) {
          res.status(200).end();
        }
      });

      // Process the request through the receiver
      await Promise.race([
        receiver.requestHandler(req, res),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout')), 2500)
        )
      ]);

    } catch (error) {
      logger.error('Error processing request:', error);
      if (!res.headersSent) {
        res.status(200).end(); // Still return 200 to Slack
      }
    }
  } else if (req.method === 'GET') {
    res.status(200).json({ status: 'ok' });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
};
